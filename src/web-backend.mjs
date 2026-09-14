/**
 * Commander's DSH Web backend: drives one agent inside the DSH Web process that
 * is already running, so the shared UI groups the Session under its Workspace
 * and streams its output live.
 *
 * A task Session is created through the public Workspace and Session Remotes
 * (`workspace/create` -> `session/create` -> `session/rename` ->
 * `session/selectModel`) and driven from durable Session events delivered by
 * `session/follow`. This backend never stops the shared Web service, never
 * deletes a Session, and never re-sends a prompt after a transport failure.
 */
import { AsyncQueue, DshWebTransport } from './web-transport.mjs';

const WORKSPACE_CREATE = 'workspace/create';
const SESSION_CREATE = 'session/create';
const SESSION_RENAME = 'session/rename';
const SESSION_SELECT_MODEL = 'session/selectModel';
const SESSION_FOLLOW = 'session/follow';
const SESSION_PROMPT = 'session/prompt';
const SESSION_CANCEL = 'session/cancel';
const EVENTS_STREAM = '$events';
const EVENTS_RESULT = '$events/result';
const APPROVAL_EVENT = 'approval/request';
const SESSION_ERROR_EVENT = 'api-session/error';
const DEFAULT_TURN_TIMEOUT_MS = 1800000;
const DEFAULT_CANCEL_TIMEOUT_MS = 30000;

/**
 * Live state for one Commander Session driven inside the shared Web process.
 * The task handle persisted by TaskManager stays plain JSON; controllers,
 * followers, and timers live only here.
 */
class WebSession {
  constructor(sessionId, workspaceId) {
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;
    this.workspacePath = undefined;
    this.turns = new Set();
    /** Latest `api-session/error` the shared Web reported for this Session. */
    this.lastError = null;
    /** Aborted when the handle is released, so a pending permission cannot hang. */
    this.controller = new AbortController();
  }
}

/** Commander backend over the owner-local DSH Web Remote API. */
export class DshWebBackend {
  /**
   * @param config - Commander config; `dshWebUrl` is required.
   * @param onPermission - TaskManager permission forwarder `(req, ctx) => decision`.
   * @param transport - transport double for tests; defaults to the real one.
   */
  constructor(config, onPermission, transport) {
    this.config = config;
    this.onPermission = onPermission;
    this.transport = transport ?? new DshWebTransport(config);
    const url = this.transport.url ?? config?.dshWebUrl;
    if (url === undefined || url === null || String(url).length === 0) {
      throw new Error('DshWebBackend requires config.dshWebUrl for the shared DSH Web service');
    }
    this.webUrl = new URL(String(url)).href;
    this.sessions = new Map();
    this.eventStream = null;
    this.approvals = new Map();
  }

  get turnTimeoutMs() {
    const value = this.config?.turnTimeoutMs;
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_TURN_TIMEOUT_MS;
  }

  get cancelTimeoutMs() {
    const value = this.config?.cancelTimeoutMs;
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_CANCEL_TIMEOUT_MS;
  }

  /**
   * Register the task's Workspace and Session in the shared Web process and pin
   * the exact model route. Every turn re-runs this, so a Session that lost its
   * Workspace membership is re-attached before the next prompt.
   * @param task - TaskManager task with cwd, title, route, and any prior handle.
   * @returns the JSON-safe handle and the confirmed route label.
   */
  async ensure(task) {
    if (task.handle?.transport === 'web' && new URL(task.handle.webUrl).href !== this.webUrl) {
      throw new Error('This task belongs to a different DSH Web service; restore its configured origin before continuing');
    }
    const cwd = requireText(task?.cwd, 'task.cwd');
    const provider = requireText(task?.provider, 'task.provider');
    const model = requireText(task?.model, 'task.model');
    const reasoningEffort = typeof task?.reasoningEffort === 'string' && task.reasoningEffort.length > 0
      ? task.reasoningEffort
      : undefined;
    const sessionId = typeof task?.handle?.backendSessionId === 'string' && task.handle.backendSessionId.length > 0
      ? task.handle.backendSessionId
      : `commander-${requireText(task?.id, 'task.id')}`;

    const workspace = await this.transport.request(WORKSPACE_CREATE, { path: cwd });
    const workspaceId = workspace?.workspace?.workspaceId;
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new Error(`DSH workspace/create did not return a workspaceId for "${cwd}"`);
    }
    const created = await this.transport.request(SESSION_CREATE, { workspaceId, sessionId });
    if (created?.sessionId !== sessionId) {
      throw new Error(`DSH session/create did not confirm Session "${sessionId}"`);
    }
    let title;
    if (typeof task?.title === 'string' && task.title.trim().length > 0) {
      const renamed = await this.transport.request(SESSION_RENAME, { sessionId, title: task.title });
      if (typeof renamed?.title !== 'string' || renamed.title.length === 0) {
        throw new Error(`DSH session/rename did not confirm a title for Session "${sessionId}"`);
      }
      title = renamed.title;
    }
    const selected = await this.transport.request(SESSION_SELECT_MODEL, {
      sessionId, provider, model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    });
    const confirmed = selected?.selected;
    if (confirmed?.provider !== provider || confirmed?.model !== model) {
      throw new Error(`DSH did not confirm the requested route: expected ${provider}/${model}, `
        + `got ${String(confirmed?.provider)}/${String(confirmed?.model)}`);
    }
    if (reasoningEffort !== undefined && confirmed?.reasoningEffort !== reasoningEffort) {
      throw new Error(`DSH did not confirm the requested reasoningEffort: expected ${reasoningEffort}, `
        + `got ${String(confirmed?.reasoningEffort)}`);
    }

    const session = this.sessions.get(sessionId) ?? new WebSession(sessionId, workspaceId);
    session.workspacePath = typeof workspace?.workspace?.path === 'string' ? workspace.workspace.path : undefined;
    this.sessions.set(sessionId, session);
    // Permission forwarding must be live before the first prompt can ask.
    this.openEventStream();

    return {
      handle: {
        backendSessionId: sessionId,
        workspaceId,
        transport: 'web',
        webUrl: this.webUrl,
        cwd,
        provider,
        model,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
        ...title === undefined ? {} : { title },
      },
      route: JSON.stringify([provider, model]),
    };
  }

  /**
   * Subscribe to the Session, then admit one queued prompt.
   * @param handle - handle returned by {@link DshWebBackend.ensure}.
   * @param text - complete prompt text for this turn.
   * @param requestId - turn identity persisted on the durable user message.
   * @param signal - turn cancellation owned by TaskManager.
   * @returns the turn contract TaskManager consumes.
   */
  start(handle, text, requestId, signal) {
    const session = this.requireSession(handle);
    if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('A turn requestId is required');
    if (typeof text !== 'string' || text.length === 0) throw new Error('A non-empty prompt is required');

    const queue = new AsyncQueue();
    const promptStarted = withResolvers();
    const settled = withResolvers();
    const matchedSignal = withResolvers();
    const state = {
      session, requestId, signal, queue, promptStarted, settled, matchedSignal,
      cursor: -1,
      lastSeq: -1,
      promptIssued: false,
      promptAccepted: false,
      matched: false,
      pendingTurnStart: null,
      turn: null,
      toolNames: new Map(),
      messageIds: new Set(),
      stream: null,
      timer: null,
      onAbort: null,
      cancelPromise: null,
      finished: false,
    };
    session.turns.add(state);
    // Errors reported before this turn started say nothing about it.
    session.lastError = null;
    const turn = {
      requestId,
      promptStarted: promptStarted.promise,
      events: queue,
      result: settled.promise,
      cancel: input => this.cancelTurn(state, input),
    };
    void this.drive(state, text).catch(error => {
      this.failTurn(state, error, `DSH turn on Session "${session.sessionId}" failed`);
    });
    return turn;
  }

  /**
   * Release this backend's local state for one handle. The shared Web Session,
   * its history, and the Web service itself are left untouched.
   * @param handle - handle previously returned by `ensure`.
   * @returns resolution after any in-flight turn is released.
   */
  async close(handle) {
    const sessionId = handle?.backendSessionId;
    if (handle?.transport !== 'web' || typeof sessionId !== 'string') return;
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    for (const turn of [...session.turns]) await this.cancelTurn(turn, { reason: 'handle closed' });
    session.controller.abort(new Error('DSH Commander released the Web Session handle'));
    if (this.sessions.size === 0) await this.closeEventStream();
  }

  /** Resolve the live Session state a handle refers to. */
  requireSession(handle) {
    const sessionId = handle?.backendSessionId;
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error('DSH Web handle carries no backendSessionId; run ensure() before start()');
    }
    if (handle?.transport !== 'web') {
      throw new Error(`DSH handle for Session "${sessionId}" belongs to the `
        + `"${String(handle?.transport)}" transport; run ensure() before start()`);
    }
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`DSH Web Session "${sessionId}" is not registered; run ensure() before start()`);
    }
    return session;
  }

  /** Open the Session, admit the prompt, then fold durable events into the turn. */
  async drive(state, text) {
    const { session } = state;
    state.timer = setTimeout(() => {
      void this.cancelTurn(state, { reason: 'turn timeout' }, `DSH turn on Session "${session.sessionId}" `
        + `produced no turn/end within ${this.turnTimeoutMs} ms; the shared Web session may still be running`);
    }, this.turnTimeoutMs);
    state.timer.unref?.();
    if (state.signal !== undefined) {
      state.onAbort = () => {
        void this.cancelTurn(state, { reason: 'controller aborted the turn' });
      };
      state.signal.addEventListener('abort', state.onAbort, { once: true });
      if (state.signal.aborted) state.onAbort();
    }

    // Permission forwarding has to be live before a prompt can raise a request.
    await this.openEventStream().ready;
    if (state.finished) return;

    const stream = this.transport.stream(SESSION_FOLLOW, {
      request: { address: { kind: 'session', sessionId: session.sessionId }, assistantStream: true, maxMessages: 1 },
    });
    state.stream = stream;
    const snapshot = await stream.ready;
    if (snapshot?.type !== 'snapshot') {
      throw new Error(`DSH ${SESSION_FOLLOW} did not open with a snapshot for Session "${session.sessionId}"`);
    }
    if (state.finished) return;
    state.cursor = typeof snapshot.cursor === 'number' ? snapshot.cursor : -1;
    state.lastSeq = state.cursor;

    state.promptIssued = true;
    const receipt = await this.transport.request(SESSION_PROMPT, {
      sessionId: session.sessionId,
      requestId: state.requestId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    });
    if (receipt?.accepted !== true) {
      throw new Error(`DSH ${SESSION_PROMPT} did not accept the prompt for Session "${session.sessionId}"`);
    }
    state.promptAccepted = true;
    state.promptStarted.resolve();

    let leading = true;
    for await (const frame of stream.events) {
      if (leading && frame?.type === 'snapshot') {
        leading = false;
        continue;
      }
      leading = false;
      this.consumeFrame(state, frame);
      if (state.finished) break;
    }
    if (!state.finished) {
      throw new Error(`DSH Web ${SESSION_FOLLOW} closed for Session "${session.sessionId}" before its turn ended`);
    }
  }

  /** Fold one durable follow frame; transient frames never reach the parent. */
  consumeFrame(state, frame) {
    if (state.finished || frame === null || typeof frame !== 'object') return;
    // Process-local assistant frames duplicate the durable assistant messages.
    if (frame.type !== 'event') return;
    const event = frame.event;
    if (event === null || typeof event !== 'object') return;
    // The opening snapshot already carried every event up to its cursor, and a
    // redelivered frame must not be folded twice.
    if (typeof event.seq === 'number' && event.seq <= state.lastSeq) return;
    if (typeof event.seq === 'number') state.lastSeq = event.seq;
    switch (event.type) {
      case 'turn/start': {
        if (state.matched && state.turn === null) state.turn = event.data?.turn ?? null;
        else if (!state.matched) state.pendingTurnStart = { turn: event.data?.turn ?? null, seq: event.seq };
        return;
      }
      case 'user/message': {
        if (state.matched || event.data?.source?.rpcId !== state.requestId) return;
        state.matched = true;
        state.matchedSignal.resolve();
        // A turn opens before it claims its queued input, so the turn this
        // request entered is the last one opened before its own receipt.
        const pending = state.pendingTurnStart;
        if (state.turn === null && pending !== null && pending.seq < event.seq && pending.turn !== null) {
          state.turn = pending.turn;
        }
        state.pendingTurnStart = null;
        return;
      }
      case 'assistant/message': {
        if (state.turn === null || event.data?.turn !== state.turn) return;
        const message = event.data?.message;
        if (message === null || typeof message !== 'object') return;
        // Surface replacements repeat one message id; the parent gets it once.
        if (typeof message.id === 'string') {
          if (state.messageIds.has(message.id)) return;
          state.messageIds.add(message.id);
        }
        for (const block of Array.isArray(message.content) ? message.content : []) {
          // Only text blocks are parent output: reasoning and every other
          // block type stay out of the transcript.
          if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) continue;
          state.queue.push({ type: 'text_delta', stream: 'output', text: block.text });
        }
        return;
      }
      case 'tool/call': {
        if (state.turn === null || event.data?.turn !== state.turn) return;
        const callId = event.data?.callId;
        if (typeof callId !== 'string' || callId.length === 0) return;
        const name = typeof event.data?.name === 'string' && event.data.name.length > 0 ? event.data.name : 'tool';
        state.toolNames.set(callId, name);
        state.queue.push({ type: 'tool_call', toolCallId: callId, title: name, text: name, kind: 'other', status: 'in_progress' });
        return;
      }
      case 'tool/result': {
        if (state.turn === null || event.data?.turn !== state.turn) return;
        const block = event.data?.message?.content?.[0];
        const callId = block?.toolCallId;
        if (typeof callId !== 'string' || callId.length === 0) return;
        const status = block?.isError === true ? 'failed' : 'completed';
        const name = state.toolNames.get(callId);
        const label = name === undefined ? status : `${name} ${status}`;
        state.queue.push({ type: 'tool_call', toolCallId: callId, title: label, text: label, kind: 'other', status });
        return;
      }
      case 'turn/end': {
        if (state.turn === null || event.data?.turn !== state.turn) return;
        // The turn this request entered ended: only this settles the result.
        this.finishTurn(state, turnEndResult(event.data?.reason));
        return;
      }
      default:
        return;
    }
  }

  /** Cancel the active turn and wait, bounded, for its own turn/end. */
  async cancelTurn(state, input, detail) {
    if (state.finished) return;
    if (state.cancelPromise !== null) return state.cancelPromise;
    const reason = typeof input?.reason === 'string' ? input.reason : 'cancelled';
    state.cancelPromise = (async () => {
      // Nothing was admitted yet: no turn of ours exists to stop.
      if (!state.promptIssued) {
        this.finishTurn(state, { status: 'cancelled', stopReason: 'cancelled' });
        return;
      }
      const admitted = await settlesWithin(state.promptStarted.promise, this.cancelTimeoutMs);
      if (state.finished) return;
      // The prompt never entered the Session, so no turn of ours is running.
      if (!admitted || !state.promptAccepted) {
        this.finishTurn(state, { status: 'cancelled', stopReason: 'cancelled' });
        return;
      }
      if (!state.matched && await this.removeQueuedPrompt(state)) {
        this.finishTurn(state, { status: 'cancelled', stopReason: 'cancelled' });
        return;
      }
      // If claim and withdrawal raced, wait for our own receipt before stopping.
      if (!state.matched && !await settlesWithin(state.matchedSignal.promise, this.cancelTimeoutMs)) {
        console.error(`dsh-commander: Session "${state.session.sessionId}" kept its queued prompt: `
          + 'no turn of this request was reached before the cancellation');
        this.finishTurn(state, {
          status: 'cancelled',
          stopReason: 'cancelled',
          detail: `Session "${state.session.sessionId}" was cancelled while its prompt was still queued; `
            + 'the shared Web session may still run that prompt',
        });
        return;
      }
      if (state.finished) return;
      await this.requestCancel(state.session);
      if (await settlesWithin(state.settled.promise, this.cancelTimeoutMs)) return;
      this.finishTurn(state, {
        status: 'cancelled',
        stopReason: 'cancel_timeout',
        detail: detail ?? `Session "${state.session.sessionId}" did not end its turn after ${reason}`,
      });
    })();
    return state.cancelPromise;
  }

  /** Withdraw only this request's still-pending inbox item. */
  async removeQueuedPrompt(state) {
    const control = this.transport.stream('session/control', {});
    try {
      if (!await settlesWithin(control.ready, this.cancelTimeoutMs)) return false;
      const baseline = await control.ready;
      const item = baseline?.value?.queues?.[state.session.sessionId]?.find(item => item.rpcId === state.requestId);
      if (!item || state.matched) return false;
      const receipt = await this.transport.request('session/updateQueue', {
        sessionId: state.session.sessionId, itemId: item.id, action: { kind: 'remove' },
      }, AbortSignal.timeout(this.cancelTimeoutMs));
      return receipt?.accepted === true;
    } catch {
      // Claim can win the race with updateQueue; the durable receipt decides next.
      return false;
    } finally {
      await control.close();
    }
  }

  /** Best-effort cancellation of this Session's turn only; never another Session's. */
  async requestCancel(session) {
    try {
      await this.transport.request(SESSION_CANCEL, { sessionId: session.sessionId }, AbortSignal.timeout(this.cancelTimeoutMs));
    } catch (error) {
      console.error(`dsh-commander: DSH ${SESSION_CANCEL} failed for Session "${session.sessionId}": ${errorMessage(error)}`);
    }
  }

  /** Settle one turn exactly once and release everything it owns. */
  finishTurn(state, result) {
    if (state.finished) return;
    state.finished = true;
    state.promptStarted.resolve();
    state.session.turns.delete(state);
    this.detach(state);
    state.queue.end();
    state.settled.resolve(result);
  }

  /** Fail one turn, then try to stop the work we can no longer follow. */
  failTurn(state, error, detail) {
    if (state.finished) return;
    const reported = state.session.lastError === null ? '' : `; the shared Web reported: ${state.session.lastError}`;
    const message = `${detail}: ${errorMessage(error)}${reported}`;
    state.promptStarted.reject(error instanceof Error ? error : new Error(message));
    this.finishTurn(state, { status: 'failed', stopReason: 'error', error: { message } });
    // No prompt re-send: the shared session keeps its history and is stopped instead.
    if (state.matched) void this.requestCancel(state.session);
  }

  /** Drop timers, listeners, and the follower owned by one finished turn. */
  detach(state) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.signal !== undefined && state.onAbort !== null) {
      state.signal.removeEventListener('abort', state.onAbort);
      state.onAbort = null;
    }
    const stream = state.stream;
    state.stream = null;
    if (stream !== null) void stream.close().catch(() => {});
  }

  /** Open the shared forwarded-event stream used for approval forwarding. */
  openEventStream() {
    if (this.eventStream !== null) return this.eventStream;
    const stream = this.transport.stream(EVENTS_STREAM, {});
    const ready = withResolvers();
    const state = { stream, clientId: null, ready: ready.promise };
    this.eventStream = state;
    void this.pumpEventStream(state, ready);
    return state;
  }

  /** Read forwarded events; a closed or unusable stream is reopened on demand. */
  async pumpEventStream(state, ready) {
    try {
      let opened = false;
      for await (const frame of state.stream.events) {
        if (!opened) {
          if (frame?.type !== 'ready' || typeof frame.clientId !== 'string') {
            throw new Error(`DSH Web ${EVENTS_STREAM} stream did not open with a ready frame`);
          }
          opened = true;
          state.clientId = frame.clientId;
          ready.resolve();
          continue;
        }
        void this.handleEvent(state, frame).catch(error => {
          console.error(`dsh-commander: DSH Web event handling failed: ${errorMessage(error)}`);
        });
      }
      if (this.eventStream === state) throw new Error(`DSH Web ${EVENTS_STREAM} stream closed`);
    } catch (error) {
      ready.reject(error);
      if (this.eventStream === state) {
        this.eventStream = null;
        for (const session of this.sessions.values()) {
          for (const turn of [...session.turns]) this.failTurn(turn, error, 'DSH approval channel disconnected');
        }
      }
      try {
        await state.stream.close();
      } catch {
        // The stream is already gone; nothing is left to release here.
      }
    }
  }

  /** Answer one forwarded frame: approvals we own, `next` for everything else. */
  async handleEvent(state, frame) {
    if (frame === null || typeof frame !== 'object') return;
    if (frame.type === 'cancel') {
      this.approvals.get(frame.eventId)?.abort();
      return;
    }
    if (frame.type === 'emit') {
      if (frame.event === SESSION_ERROR_EVENT && Array.isArray(frame.args)) {
        const session = this.sessions.get(frame.args[0]);
        if (session !== undefined) session.lastError = String(frame.args[1] ?? 'unknown session error');
      }
      return;
    }
    if (frame.type !== 'waterfall') return;
    const session = this.sessions.get(frame.agentId);
    if (frame.event === APPROVAL_EVENT && session !== undefined && typeof this.onPermission === 'function') {
      await this.answerApproval(state, frame, session);
      return;
    }
    // Questions, other agents' work, and every unowned event belong to the Web UI.
    await this.answer(state, frame.eventId, { kind: 'next' });
  }

  /** Forward one approval to the parent decision channel and answer with its outcome. */
  async answerApproval(state, frame, session) {
    const request = frame.request ?? {};
    const controller = new AbortController();
    this.approvals.set(frame.eventId, controller);
    let decision;
    try {
      decision = await this.onPermission({
        sessionId: session.sessionId,
        inferredKind: undefined,
        raw: {
          sessionId: session.sessionId,
          toolCall: {
            toolCallId: typeof request.callId === 'string' ? request.callId : '',
            title: typeof request.toolName === 'string' && request.toolName.length > 0 ? request.toolName : 'tool',
            rawInput: { ...(request.reason ? { reason: request.reason } : {}), ...(request.callId ? { callId: request.callId } : {}) },
          },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      }, { signal: AbortSignal.any([session.controller.signal, controller.signal]) });
    } catch (error) {
      console.error(`dsh-commander: approval forwarding failed for Session "${session.sessionId}": ${errorMessage(error)}`);
      decision = undefined;
    }
    this.approvals.delete(frame.eventId);
    if (!controller.signal.aborted) await this.answer(state, frame.eventId, { kind: 'result', value: approvalOutcome(decision) });
  }

  /** Send one event outcome; a dropped answer would leave the request pending. */
  async answer(state, eventId, outcome) {
    if (typeof state.clientId !== 'string') return;
    try {
      await this.transport.rpc(EVENTS_RESULT, { clientId: state.clientId, eventId, outcome });
    } catch (error) {
      console.error(`dsh-commander: DSH Web ${EVENTS_RESULT} failed: ${errorMessage(error)}`);
      await state.stream.close();
    }
  }

  /** Release the shared forwarded-event stream. */
  async closeEventStream() {
    const state = this.eventStream;
    if (state === null) return;
    this.eventStream = null;
    try {
      await state.stream.close();
    } catch {
      // Closing an already-closed stream is not a failure worth reporting.
    }
  }
}

/** Map the DSH turn ending onto the turn result TaskManager consumes. */
function turnEndResult(reason) {
  switch (reason?.kind) {
    case 'completed':
      return { status: 'completed', stopReason: 'end_turn' };
    case 'max-tokens':
      return { status: 'completed', stopReason: 'max_tokens' };
    case 'blocked':
      return { status: 'completed', stopReason: 'blocked' };
    case 'aborted':
      return { status: 'cancelled', stopReason: 'cancelled' };
    case 'interrupted':
      return { status: 'cancelled', stopReason: 'interrupted' };
    case 'error':
      return {
        status: 'failed',
        stopReason: 'error',
        error: { message: typeof reason.error?.message === 'string' ? reason.error.message : 'DSH turn failed' },
      };
    default:
      return { status: 'failed', stopReason: 'error', error: { message: `Unsupported DSH turn end reason: ${String(reason?.kind)}` } };
  }
}

/** Translate the parent's permission decision into the DSH approval outcome. */
function approvalOutcome(decision) {
  const outcome = typeof decision === 'string' ? decision : decision?.outcome;
  if (outcome === 'allow_once' || outcome === 'allow_always') return 'allowed-once';
  if (outcome === 'reject_once' || outcome === 'reject_always') return 'rejected';
  return 'cancelled';
}

/** Wait for one promise to settle, bounded; the timer never keeps the loop alive. */
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(false), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Promise with externally reachable settlement, pre-handled so it can never throw alone. */
function withResolvers() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required for the DSH Web backend`);
  return value;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
