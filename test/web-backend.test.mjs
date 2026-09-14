/**
 * Behaviour tests for the DSH Web backend: group registration, session
 * resumption, receipt-scoped completion, cancellation, disconnects, and
 * permission isolation. The transport is a double, so every frame is driven by
 * the test rather than by a live Web service.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncQueue } from '../src/web-transport.mjs';
import { DshWebBackend } from '../src/web-backend.mjs';
import { waitUntil } from './helpers.mjs';

const SESSION = '11111111-1111-1111-1111-111111111111';
const CWD = 'C:\\work\\demo';
const WEB_URL = 'http://127.0.0.1:3080';

class FakeStream {
  constructor() {
    this.queue = new AsyncQueue();
    this.opened = false;
    this.closed = false;
    this.ready = new Promise((resolve, reject) => { this.settle = { resolve, reject }; });
    this.ready.catch(() => {});
  }
  get events() { return this.queue; }
  /** Mirror the real transport: the first frame both opens `ready` and enters `events`. */
  push(frame) {
    if (!this.opened) { this.opened = true; this.settle.resolve(frame); }
    this.queue.push(frame);
  }
  fail(error) {
    if (!this.opened) { this.opened = true; this.settle.reject(error); }
    this.queue.end(error);
  }
  async close() { this.closed = true; this.queue.end(); }
}

class FakeTransport {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.log = [];
    this.url = new URL(WEB_URL);
    this.streams = new Map();
  }
  async request(endpoint, request) {
    this.log.push({ kind: 'request', endpoint, request });
    const handler = this.handlers[endpoint];
    if (!handler) throw new Error(`unexpected DSH Web request ${endpoint}`);
    return handler(request);
  }
  async rpc(endpoint, args) {
    this.log.push({ kind: 'rpc', endpoint, args });
    const handler = this.handlers[endpoint];
    return handler ? handler(args) : undefined;
  }
  stream(endpoint, args) {
    this.log.push({ kind: 'stream', endpoint, args });
    const stream = new FakeStream();
    this.streams.set(endpoint, stream);
    return stream;
  }
  requests(endpoint) { return this.log.filter(call => call.kind === 'request' && call.endpoint === endpoint); }
  lastStream(endpoint) { return this.streams.get(endpoint); }
  frame(endpoint) { return this.log.find(call => call.kind === 'stream' && call.endpoint === endpoint); }
}

function config(extra = {}) {
  return { dshWebUrl: WEB_URL, turnTimeoutMs: 60000, cancelTimeoutMs: 500, ...extra };
}

function task(extra = {}) {
  return {
    id: '22222222-2222-2222-2222-222222222222',
    cwd: CWD,
    title: 'demo task',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    reasoningEffort: 'high',
    // A resumed task already carries the handle of its previous turn.
    handle: { backendSessionId: SESSION, workspaceId: 'ws-1', transport: 'web', webUrl: WEB_URL },
    ...extra,
  };
}

function handlers(sessionId = SESSION) {
  return {
    'workspace/create': request => ({
      created: false,
      workspace: { workspaceId: 'ws-1', path: request.path, title: 'demo', sessionIds: [sessionId], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }),
    'session/create': request => ({ sessionId: request.sessionId }),
    'session/rename': request => ({ title: request.title, seq: 4 }),
    'session/selectModel': request => ({
      selected: {
        provider: request.provider,
        model: request.model,
        ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort },
      },
    }),
    'session/prompt': () => ({ accepted: true }),
    'session/cancel': () => ({ accepted: true }),
  };
}

const snapshot = (cursor = 10) => ({
  type: 'snapshot',
  header: { version: 3, id: SESSION, createdAt: 1, cwd: CWD, isSeeded: false },
  cursor, records: [], hasMore: false, projections: { asOfSeq: cursor, values: {} },
});
const event = (type, seq, data) => ({ type: 'event', event: { type, seq, time: seq, data } });
const userMessage = (seq, rpcId) => event('user/message', seq, {
  id: `u-${seq}`, role: 'user', content: [{ type: 'text', text: 'prompt' }], source: { kind: 'user', rpcId },
});
const assistantMessage = (seq, turn, content, id = `a-${seq}`) => event('assistant/message', seq, {
  turn, step: 1, stream: [],
  message: {
    id, role: 'assistant', content,
    source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  },
});

/** Register the task and open the shared forwarded-event stream. */
async function ready(backend, transport, input = task()) {
  const ensured = await backend.ensure(input);
  transport.lastStream('$events').push({ type: 'ready', clientId: 'web-client-1', host: { home: '/home/tester' } });
  return ensured;
}

/** Start a turn and drive it through subscription and prompt admission. */
async function startTurn(backend, transport, handle, { text = 'do the thing', requestId = 'req-1' } = {}) {
  const turn = backend.start(handle, text, requestId);
  await waitUntil(() => transport.lastStream('session/follow') !== undefined, 'follow stream opened');
  const follow = transport.lastStream('session/follow');
  follow.push(snapshot());
  await waitUntil(() => transport.requests('session/prompt').length > 0, 'prompt issued');
  return { turn, follow };
}

async function collect(turn) {
  const events = [];
  for await (const item of turn.events) events.push(item);
  return { events, result: await turn.result };
}

test('ensure registers the task in a workspace and confirms the exact route', async () => {
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config(), undefined, transport);
  const { handle, route } = await backend.ensure(task());

  assert.equal(handle.backendSessionId, SESSION);
  assert.equal(handle.workspaceId, 'ws-1');
  assert.equal(handle.transport, 'web');
  assert.equal(handle.webUrl, `${WEB_URL}/`);
  assert.equal(route, '["deepseek-official","deepseek-v4-flash"]');
  // TaskManager persists the handle as task JSON: it must round-trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(handle)), handle);

  assert.deepEqual(transport.requests('workspace/create')[0].request, { path: CWD });
  assert.deepEqual(transport.requests('session/create')[0].request, { workspaceId: 'ws-1', sessionId: SESSION });
  assert.deepEqual(transport.requests('session/rename')[0].request, { sessionId: SESSION, title: 'demo task' });
  assert.deepEqual(transport.requests('session/selectModel')[0].request, {
    sessionId: SESSION, provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'high',
  });
  assert.equal(transport.log.some(call => /delete/.test(call.endpoint)), false);
});

test('ensure resumes the persisted session id and derives one otherwise', async () => {
  const transport = new FakeTransport(handlers('commander-existing'));
  const backend = new DshWebBackend(config(), undefined, transport);
  const resumed = await backend.ensure(task({ handle: { backendSessionId: 'commander-existing', transport: 'web', webUrl: WEB_URL } }));
  assert.equal(resumed.handle.backendSessionId, 'commander-existing');
  assert.deepEqual(transport.requests('session/create')[0].request, { workspaceId: 'ws-1', sessionId: 'commander-existing' });

  // A task with no handle yet gets one stable id derived from its task id.
  const fresh = await backend.ensure({ ...task(), handle: undefined });
  assert.equal(fresh.handle.backendSessionId, `commander-${task().id}`);
  assert.equal(transport.requests('session/create')[1].request.sessionId, `commander-${task().id}`);
});

test('a turn reports only post-receipt durable text and completes on its own turn/end', async () => {
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config(), undefined, transport);
  const { handle } = await ready(backend, transport);

  const turn = backend.start(handle, 'do the thing', 'req-1');
  await waitUntil(() => transport.lastStream('session/follow') !== undefined, 'follow stream opened');
  assert.equal(transport.requests('session/prompt').length, 0, 'prompt must wait for the first follow frame');
  const follow = transport.lastStream('session/follow');
  follow.push(snapshot());
  await waitUntil(() => transport.requests('session/prompt').length > 0, 'prompt issued');
  assert.deepEqual(transport.frame('session/follow').args, {
    request: { address: { kind: 'session', sessionId: SESSION }, assistantStream: true, maxMessages: 1 },
  });
  assert.deepEqual(transport.requests('session/prompt')[0].request, {
    sessionId: SESSION, requestId: 'req-1', mode: 'queue', content: [{ type: 'text', text: 'do the thing' }],
  });

  // History already carried by the opening snapshot must never decide anything.
  follow.push(assistantMessage(4, 1, [{ type: 'text', text: 'stale history' }]));
  follow.push(event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }));
  follow.push(event('turn/start', 11, { turn: 1 }));
  follow.push(userMessage(12, 'req-1'));
  // A process-local transient frame repeats the durable message and is ignored.
  follow.push({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'x', revision: 1, index: 0, time: 13, chunk: { type: 'text', text: 'do the thing' } } });
  follow.push(assistantMessage(13, 1, [
    { type: 'reasoning', text: 'SECRET THOUGHT' },
    { type: 'text', text: 'first half' },
  ]));
  // A repeated frame reusing one message id (the id both the ACP bridge and
  // the Web UI correlate on) must not be folded into the parent transcript twice.
  follow.push(assistantMessage(14, 1, [{ type: 'text', text: 'first half' }], 'a-13'));
  follow.push(event('tool/call', 15, { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' }));
  follow.push(event('tool/result', 16, {
    turn: 1, step: 1,
    message: { id: 'r-1', role: 'user', content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], isError: false }], source: { kind: 'tool', callId: 'call-1', name: 'bash' } },
  }));
  follow.push(event('turn/end', 17, { turn: 1, reason: { kind: 'completed' } }));

  const { events, result } = await collect(turn);
  assert.deepEqual(events.filter(item => item.type === 'text_delta').map(item => item.text), ['first half']);
  assert.deepEqual(events.filter(item => item.type === 'tool_call'), [
    { type: 'tool_call', toolCallId: 'call-1', title: 'bash', text: 'bash', kind: 'other', status: 'in_progress' },
    { type: 'tool_call', toolCallId: 'call-1', title: 'bash completed', text: 'bash completed', kind: 'other', status: 'completed' },
  ]);
  assert.equal(events.some(item => item.type === 'text_delta' && item.text.includes('SECRET')), false);
  assert.deepEqual(result, { status: 'completed', stopReason: 'end_turn' });
});

test('cancel asks the shared Web to stop this session and ends on its turn/end', async () => {
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config(), undefined, transport);
  const { handle } = await ready(backend, transport);
  const { turn, follow } = await startTurn(backend, transport, handle);
  follow.push(event('turn/start', 11, { turn: 1 }));
  follow.push(userMessage(12, 'req-1'));
  await waitUntil(() => transport.requests('session/cancel').length === 0, 'no cancel yet');

  const cancellation = turn.cancel({ reason: 'parent requested cancellation' });
  await waitUntil(() => transport.requests('session/cancel').length === 1, 'cancel issued');
  assert.deepEqual(transport.requests('session/cancel')[0].request, { sessionId: SESSION });
  follow.push(event('turn/end', 13, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }));

  assert.equal(await cancellation, undefined);
  const { events, result } = await collect(turn);
  assert.deepEqual(result, { status: 'cancelled', stopReason: 'cancelled' });
  assert.equal(events.length, 0);
  assert.equal(transport.requests('session/prompt').length, 1, 'a cancel must never re-send the prompt');
});

test('cancel gives up after the bounded wait instead of hanging the controller', async () => {
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config({ cancelTimeoutMs: 120 }), undefined, transport);
  const { handle } = await ready(backend, transport);
  const { turn, follow } = await startTurn(backend, transport, handle);
  follow.push(event('turn/start', 11, { turn: 1 }));
  follow.push(userMessage(12, 'req-1'));

  await turn.cancel({ reason: 'stop' });
  const { result } = await collect(turn);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stopReason, 'cancel_timeout');
  assert.equal(transport.requests('session/cancel').length, 1);
});

test('a dropped follow stream fails the turn and stops it without resending the prompt', async () => {
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config(), undefined, transport);
  const { handle } = await ready(backend, transport);
  const { turn, follow } = await startTurn(backend, transport, handle);
  follow.push(event('turn/start', 11, { turn: 1 }));
  follow.push(userMessage(12, 'req-1'));
  follow.push(assistantMessage(13, 1, [{ type: 'text', text: 'partial' }]));

  follow.fail(new Error('DSH Web stream session/follow disconnected; work may continue in the Web UI'));
  const { events, result } = await collect(turn);
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /disconnected/);
  assert.deepEqual(events.filter(item => item.type === 'text_delta').map(item => item.text), ['partial']);
  assert.equal(transport.requests('session/prompt').length, 1);
  await waitUntil(() => transport.requests('session/cancel').length === 1, 'cancel attempted after the disconnect');
});

test('approvals are forwarded for owned sessions only and every other waterfall delegates', async () => {
  const seen = [];
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config(), async (request, context) => {
    seen.push({ request, aborted: context.signal.aborted });
    return { outcome: 'allow_once' };
  }, transport);
  const { handle } = await ready(backend, transport);
  const events = transport.lastStream('$events');

  events.push({ type: 'waterfall', event: 'approval/request', eventId: 'e1', agentId: SESSION, request: { toolName: 'bash', callId: 'call-1', reason: 'Escalation' } });
  await waitUntil(() => transport.log.some(call => call.endpoint === '$events/result' && call.args.eventId === 'e1'), 'approval answered');
  const approval = transport.log.find(call => call.endpoint === '$events/result' && call.args.eventId === 'e1');
  assert.deepEqual(approval.args, {
    clientId: 'web-client-1',
    eventId: 'e1',
    outcome: { kind: 'result', value: 'allowed-once' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].aborted, false);
  assert.equal(seen[0].request.sessionId, SESSION);
  assert.equal(seen[0].request.raw.toolCall.toolCallId, 'call-1');
  assert.equal(seen[0].request.raw.toolCall.title, 'bash');
  assert.deepEqual(seen[0].request.raw.options.map(option => option.kind), ['allow_once', 'reject_once']);

  // Another agent's approval, user questions, and cancellations stay with the Web UI.
  events.push({ type: 'waterfall', event: 'approval/request', eventId: 'e2', agentId: 'someone-else', request: { toolName: 'bash' } });
  events.push({ type: 'waterfall', event: 'user-questions/request', eventId: 'e3', agentId: SESSION, request: { questions: [] } });
  events.push({ type: 'cancel', eventId: 'e4' });
  await waitUntil(() => transport.log.some(call => call.endpoint === '$events/result' && call.args.eventId === 'e3'), 'delegated events answered');
  for (const id of ['e2', 'e3']) {
    const answered = transport.log.find(call => call.endpoint === '$events/result' && call.args.eventId === id);
    assert.deepEqual(answered.args.outcome, { kind: 'next' });
  }
  assert.equal(transport.log.some(call => call.endpoint === '$events/result' && call.args.eventId === 'e4'), false);
  assert.equal(seen.length, 1, 'only our own session may consume a parent decision');

  // A rejected parent decision fails closed for the tool that asked.
  const rejecting = new DshWebBackend(config(), async () => { throw new Error('parent unavailable'); }, new FakeTransport(handlers()));
  await rejecting.ensure(task());
  const rejectEvents = rejecting.transport.lastStream('$events');
  rejectEvents.push({ type: 'ready', clientId: 'web-client-2', host: { home: '/home/tester' } });
  rejectEvents.push({ type: 'waterfall', event: 'approval/request', eventId: 'e9', agentId: SESSION, request: { toolName: 'bash' } });
  await waitUntil(() => rejecting.transport.log.some(call => call.endpoint === '$events/result' && call.args.eventId === 'e9'), 'rejected approval answered');
  const rejected = rejecting.transport.log.find(call => call.endpoint === '$events/result' && call.args.eventId === 'e9');
  assert.deepEqual(rejected.args.outcome, { kind: 'result', value: 'cancelled' });
  await backend.close(handle);
});

test('shared Web session errors reach our own failure report and never another session', async () => {
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config(), undefined, transport);
  const { handle } = await ready(backend, transport);
  const events = transport.lastStream('$events');
  events.push({ type: 'emit', event: 'api-session/error', args: ['someone-else', 'foreign failure'] });
  events.push({ type: 'emit', event: 'api-session/error', args: [SESSION, 'stale failure before the turn'] });

  const { turn, follow } = await startTurn(backend, transport, handle);
  follow.push(event('turn/start', 11, { turn: 1 }));
  follow.push(userMessage(12, 'req-1'));
  // Matching our receipt retires earlier noise; a fresh error during the turn is kept.
  events.push({ type: 'emit', event: 'api-session/error', args: [SESSION, 'turn stream failed'] });
  follow.fail(new Error('follow closed'));

  const { result } = await collect(turn);
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /turn stream failed/);
  assert.doesNotMatch(result.error.message, /foreign failure/);
  assert.doesNotMatch(result.error.message, /stale failure before the turn/);
});

test('close releases only local state and leaves the shared Web session alone', async () => {
  const transport = new FakeTransport(handlers());
  const backend = new DshWebBackend(config(), undefined, transport);
  const { handle } = await ready(backend, transport);
  await backend.close(handle);
  assert.equal(transport.requests('session/cancel').length, 0);
  assert.equal(transport.log.some(call => /delete/.test(call.endpoint)), false);
  assert.equal(transport.lastStream('$events').closed, true);

  // A handle from the previous ACP transport is not ours to close.
  const other = new FakeTransport(handlers());
  const otherBackend = new DshWebBackend(config(), undefined, other);
  await otherBackend.close({ backendSessionId: 'acp-session', transport: 'acp' });
  assert.equal(other.log.length, 0);
});

test('a missing web url fails loud at construction', () => {
  assert.throws(() => new DshWebBackend({}, undefined, { url: undefined }), /dshWebUrl/);
});


test('cancel removes only the matching queued prompt without stopping another turn', async () => {
  const transport = new FakeTransport({...handlers(), 'session/updateQueue': () => ({accepted:true})});
  const backend = new DshWebBackend(config(), undefined, transport);
  const {handle}=await ready(backend,transport);
  const {turn}=await startTurn(backend,transport,handle);
  const cancelling=turn.cancel({reason:'queued cancellation'});
  await waitUntil(()=>transport.lastStream('session/control')!==undefined,'control opened');
  transport.lastStream('session/control').push({type:'baseline',value:{queues:{[SESSION]:[
    {id:'foreign',rpcId:'other'}, {id:'own',rpcId:'req-1'},
  ]}}});
  await cancelling;
  assert.equal((await turn.result).status,'cancelled');
  assert.deepEqual(transport.requests('session/updateQueue')[0].request,{sessionId:SESSION,itemId:'own',action:{kind:'remove'}});
  assert.equal(transport.requests('session/cancel').length,0);
  await backend.close(handle);
});

test('an approval cancellation aborts the parent waiter without sending a stale answer',async()=>{
  let parentSignal;
  const transport=new FakeTransport(handlers());
  const backend=new DshWebBackend(config(),(_request,{signal})=>new Promise(resolve=>{
    parentSignal=signal;signal.addEventListener('abort',()=>resolve({outcome:'cancel'}),{once:true});
  }),transport);
  const {handle}=await ready(backend,transport);
  const events=transport.lastStream('$events');
  events.push({type:'waterfall',event:'approval/request',eventId:'pending',agentId:SESSION,request:{toolName:'pwsh',reason:'needs review'}});
  await waitUntil(()=>parentSignal!==undefined,'parent received approval');
  events.push({type:'cancel',eventId:'pending'});
  await waitUntil(()=>parentSignal.aborted,'parent released');
  assert.equal(transport.log.some(call=>call.endpoint==='$events/result'),false);
  await backend.close(handle);
});

test('losing the approval channel fails active work promptly',async()=>{
  const transport=new FakeTransport(handlers());
  const backend=new DshWebBackend(config(),undefined,transport);
  const {handle}=await ready(backend,transport);
  const {turn,follow}=await startTurn(backend,transport,handle);
  follow.push(event('turn/start',11,{turn:1}));follow.push(userMessage(12,'req-1'));
  await waitUntil(()=>[...backend.sessions.get(SESSION).turns][0].matched,'receipt matched');
  transport.lastStream('$events').fail(new Error('socket lost'));
  const result=await turn.result;
  assert.equal(result.status,'failed');assert.match(result.error.message,/approval channel disconnected/);
  await backend.close(handle);
});

test('a stored web handle cannot be resumed against a different origin',async()=>{
  const transport=new FakeTransport(handlers());
  const backend=new DshWebBackend(config(),undefined,transport);
  await assert.rejects(backend.ensure(task({handle:{backendSessionId:SESSION,transport:'web',webUrl:'http://127.0.0.1:9999'}})),/different DSH Web/);
  assert.equal(transport.log.length,0);
});
