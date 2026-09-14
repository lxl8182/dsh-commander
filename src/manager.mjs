import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { atomicJson, doctor, version } from './config.mjs';
import { createBackend } from './backend.mjs';
import { composeTurnPrompt, contractId } from './contract.mjs';
import { fallbackExcerpt, fallbackLimit, parseTurnReport } from './report.mjs';

const terminal=new Set(['completed','failed','cancelled','interrupted','closed']);
const now=()=>new Date().toISOString();
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clip=(value,n=4000)=>String(value??'').slice(0,n);
const EVENT_WINDOW=200;
const EVENT_PAGE_MAX=50;
/** Windows resolves workspace paths case-insensitively; POSIX does not. */
const sameDirectory=(left,right)=>process.platform==='win32'?left.toLowerCase()===right.toLowerCase():left===right;
// A turn that ended because of a failure also ends its queued follow-ups; those
// follow-ups must not mask the result of the turn that actually ended.
const wakeForStatus=new Set(['waiting_permission']);

/** One daemon owns tasks. Disk snapshots survive MCP clients and daemon restarts. */
export class TaskManager extends EventEmitter {
  constructor(config,backendFactory=createBackend) {
    super(); this.config=config; this.tasks=new Map(); this.active=new Map(); this.permissions=new Map(); this.closing=new Map(); this.stopping=false;
    // Snapshots that cannot be read are skipped, never fatal: one damaged file
    // must not stop the controller and every other task with it.
    this.skippedTaskFiles=[];
    fs.mkdirSync(path.join(config.stateDir,'tasks'),{recursive:true});
    this.backend=backendFactory(config,(req,ctx)=>this.requestPermission(req,ctx));
    for(const name of fs.readdirSync(path.join(config.stateDir,'tasks'))) {
      // Only <taskId>.json is a snapshot. Turn artifacts share this directory and
      // must be ignored by name: <taskId>.<turnId>.report.json would otherwise be
      // read as a task and stop the whole controller.
      if(!/^[a-f0-9-]{36}\.json$/.test(name))continue;
      const file=path.join(config.stateDir,'tasks',name);
      let task;
      try {
        task=JSON.parse(fs.readFileSync(file,'utf8'));
        if(!task||typeof task!=='object')throw new Error('snapshot is not an object');
        if(!/^[a-f0-9-]{36}$/.test(task.id))throw new Error('invalid persisted task id');
        if(!Array.isArray(task.turns))throw new Error('snapshot has no turn list');
      } catch(error) {
        this.skippedTaskFiles.push({file,reason:error.message});
        console.error(`Skipping unreadable task snapshot ${file}: ${error.message}`);
        continue;
      }
      // Old snapshots predate versioned reports. Only executed turns with a
      // completion timestamp are results; cancelled queued instructions are not.
      task.turns.forEach((turn,index)=>{turn.seq??=index+1;});
      const recovered=task.turns.findLast(t=>terminal.has(t.status)&&t.completedAt);
      if(!task.resultTurnId&&recovered){
        this.finalizeTurn(task,recovered);
      }
      task.resultVersion??=0;
      this.tasks.set(task.id,task);
      // Never replay writes automatically after a crash. Resume needs a new instruction.
      if(!terminal.has(task.status)) {
        task.status='interrupted'; task.error='Controller restarted during work. Inspect output and continue explicitly.';
        const interrupted=task.turns.findLast(t=>t.status==='running');
        for(const turn of task.turns)if(!terminal.has(turn.status))turn.status='interrupted';
        if(interrupted){interrupted.completedAt=now();interrupted.error=task.error;this.finalizeTurn(task,interrupted);}
        task.pendingPermissions=[];this.save(task);
      }
    }
  }
  file(task){return path.join(this.config.stateDir,'tasks',task.id+'.json');}
  eventsFile(task){return path.join(this.config.stateDir,'tasks',task.id+'.events.jsonl');}
  resultFile(task,turn){return turn?path.join(this.config.stateDir,'tasks',task.id+'.'+turn.id+'.result.txt'):null;}
  finalTextFile(task,turn){return turn?path.join(this.config.stateDir,'tasks',task.id+'.'+turn.id+'.final.txt'):null;}
  reportFile(task,turn){return turn?path.join(this.config.stateDir,'tasks',task.id+'.'+turn.id+'.report.json'):null;}
  save(task){task.updatedAt=now();atomicJson(this.file(task),task);this.emit('change',task.id);}
  get(id){const task=this.tasks.get(id);if(!task)throw new Error('Task not found: '+id);return task;}
  append(task,event){
    const record={seq:++task.cursor,time:now(),...event};
    fs.appendFileSync(this.eventsFile(task),JSON.stringify(record)+'\n',{mode:0o600});
    task.events.push(record); if(task.events.length>EVENT_WINDOW)task.events.shift();
    this.save(task);
  }
  /** Persist the bounded result of one finished turn and publish its version. */
  finalizeTurn(task,turn){
    turn.output??='';
    fs.writeFileSync(this.resultFile(task,turn),turn.output,{mode:0o600});
    const parsed=parseTurnReport(turn.output);
    // A structured report carries the conclusion without inlining progress.
    // Otherwise return a bounded tail, explicitly labelled as fallback.
    const text=parsed.report?null:fallbackExcerpt(turn.output);
    turn.finalText=text;
    turn.finalTextTruncated=!parsed.report&&turn.output.trim().length>fallbackLimit;
    turn.finalTextPath=this.finalTextFile(task,turn);
    fs.writeFileSync(turn.finalTextPath,text??'',{mode:0o600});
    turn.report=parsed.report;
    turn.reportFallbackReason=parsed.reason;
    turn.resultVersion=turn.seq;
    if(parsed.report)fs.writeFileSync(this.reportFile(task,turn),JSON.stringify(parsed.report,null,2),{mode:0o600});
    // The version identifies the turn that actually ended; publish it before
    // any waiter can observe the finished turn.
    task.resultVersion=turn.seq;task.resultTurnId=turn.id;
    if(turn.seq>task.cursor)task.cursor=turn.seq;
  }
  /** Sequence number of the last event handed to the caller by an events page. */
  pageCursor(cursor,pending){const start=Math.max(0,cursor);const last=pending.at(-1);return last?last.seq:start;}
  eventPage(task,cursor,limit){
    const start=Math.max(0,cursor);
    const size=Number.isInteger(limit)?Math.min(Math.max(1,limit),EVENT_PAGE_MAX):EVENT_PAGE_MAX;
    const pending=task.events.filter(e=>e.seq>start);
    const page=pending.slice(0,size);
    const nextCursor=this.pageCursor(start,page);
    const latest=task.events.at(-1)?.seq??0;
    const oldest=task.events[0]?.seq??task.cursor+1;
    return {events:page,nextCursor,latestCursor:latest,hasMore:latest>nextCursor,
      // last sequence that aged out of the retained window and can no longer be
      // delivered; the events themselves stay readable in the events artifact
      eventsDroppedBefore:Math.max(0,oldest-1),eventsTruncated:start<oldest-1,retainedEvents:task.events.length};
  }
  compactSnapshot(task,afterResultVersion=undefined){
    const last=task.turns.at(-1);
    const turn=this.resultTurn(task);
    const latestEvent=task.events.at(-1)?.seq??task.cursor;
    const oldestEvent=task.events[0]?.seq??task.cursor+1;
    const state=this.resultState(task,afterResultVersion);
    return {taskId:task.id,title:task.title,cwd:task.cwd,provider:task.provider,model:task.model,reasoningEffort:task.reasoningEffort,
      status:task.status,sessionId:task.handle?.backendSessionId,confirmedRoute:task.confirmedRoute,
      createdAt:task.createdAt,updatedAt:task.updatedAt,cursor:latestEvent,latestCursor:task.cursor,eventsDroppedBefore:Math.max(0,oldestEvent-1),
      turnCount:task.turns.length,
      resultVersion:task.resultVersion??0,resultTurnId:turn?.id??null,afterResultVersion:state.afterVersion,
      report:state.report,reportOutcome:state.report?.outcome??null,
      reportState:state.state,reportVersion:state.version,
      finalText:state.finalText,finalTextTruncated:state.finalTextTruncated,
      resultFallback:state.fallback,resultFallbackReason:state.reason,
      unresolved:state.report?.unresolved??[],decision:state.report?.decision??null,
      error:task.error,
      pendingPermissions:task.pendingPermissions,
      // Artifact paths describe what exists on disk, so they stay stable while
      // the report body itself is only re-sent for a version the caller has not
      // confirmed yet.
      artifacts:{task:this.file(task),events:this.eventsFile(task),result:this.resultFile(task,turn),finalText:this.finalTextFile(task,turn),report:turn?.report?this.reportFile(task,turn):null},
      turn:{id:last?.id??null,status:last?.status??null,stopReason:last?.stopReason??null,error:last?.error??null}};
  }
  snapshot(task,cursor=0,{view='compact',afterResultVersion=undefined,limit=EVENT_PAGE_MAX}={}){
    if(view==='events')return this.diagnosticSnapshot(task,cursor,afterResultVersion,limit);
    return this.compactSnapshot(task,afterResultVersion);
  }
  diagnosticSnapshot(task,cursor,afterResultVersion,limit){
    const latest=task.turns.at(-1);
    const resultTurn=this.resultTurn(task);
    const page=this.eventPage(task,cursor,limit);
    const state=this.resultState(task,afterResultVersion);
    return {view:'events',taskId:task.id,title:task.title,cwd:task.cwd,provider:task.provider,model:task.model,reasoningEffort:task.reasoningEffort,
      status:task.status,sessionId:task.handle?.backendSessionId,confirmedRoute:task.confirmedRoute,
      createdAt:task.createdAt,updatedAt:task.updatedAt,
      cursor:page.nextCursor,latestCursor:page.latestCursor,hasMore:page.hasMore,
      events:page.events,eventsTruncated:page.eventsTruncated,eventsDroppedBefore:page.eventsDroppedBefore,
      turns:task.turns.map(t=>({id:t.id,status:t.status,createdAt:t.createdAt,completedAt:t.completedAt,stopReason:t.stopReason,error:t.error,resultVersion:t.resultVersion??null})),
      turnCount:task.turns.length,
      resultVersion:task.resultVersion??0,resultTurnId:resultTurn?.id??null,afterResultVersion:state.afterVersion,
      report:state.report,reportOutcome:state.report?.outcome??null,reportState:state.state,reportVersion:state.version,
      finalText:state.finalText,finalTextTruncated:state.finalTextTruncated,
      resultFallback:state.fallback,resultFallbackReason:state.reason,
      unresolved:state.report?.unresolved??[],decision:state.report?.decision??null,
      error:task.error,
      pendingPermissions:task.pendingPermissions,
      artifacts:{task:this.file(task),events:this.eventsFile(task),result:this.resultFile(task,resultTurn),finalText:this.finalTextFile(task,resultTurn),report:resultTurn?.report?this.reportFile(task,resultTurn):null}};
  }
  /** The turn whose result the caller is entitled to read. */
  resultTurn(task){
    if(task.resultTurnId){const turn=task.turns.find(t=>t.id===task.resultTurnId);if(turn)return turn;}
    return task.turns.findLast(t=>terminal.has(t.status)&&t.completedAt)??null;
  }
  resultState(task,afterResultVersion=undefined){
    const current=task.resultVersion??0;
    const turn=this.resultTurn(task);
    const after=normalizeVersion(afterResultVersion);
    const fresh=turn&&current>0&&after!==current;
    if(!fresh)return {state:current>0?'omitted':'pending',version:current,afterVersion:after??null,report:null,finalText:null,
      finalTextTruncated:false,fallback:false,reason:current>0?'result_already_delivered':'turn_still_running'};
    // No structured report: the bounded tail is still returned, but always
    // labelled as a fallback so it can never be read as a verified result.
    const fallback=!turn.report;
    return {state:'returned',version:current,afterVersion:after??null,report:turn.report,finalText:turn.finalText,
      finalTextTruncated:Boolean(turn.finalTextTruncated),fallback,
      reason:turn.report?'structured_report':turn.finalText?.trim()?turn.reportFallbackReason||'report_missing':`turn_${turn.status}_without_output`};
  }
  start(input){
    if(this.stopping)throw new Error('Controller is shutting down');
    if(!input.cwd)throw new Error('The current Codex workspace was not resolved; retry the tool call from the active Codex session.');
    const cwd=fs.realpathSync(input.cwd);
    if(!fs.statSync(cwd).isDirectory())throw new Error('cwd must be an existing directory');
    const payload={cwd,title:input.title,prompt:input.prompt,reasoningEffort:input.reasoningEffort||this.config.reasoningEffort};
    const digest=fingerprint(payload);
    const existing=[...this.tasks.values()].find(t=>t.requestId===input.requestId);
    if(existing){if(existing.fingerprint!==digest)throw new Error('requestId already used for different task');return this.snapshot(existing,0,input);}
    if([...this.tasks.values()].filter(t=>!terminal.has(t.status)).length>=100)throw new Error('Task queue is full');
    const task={id:randomUUID(),requestId:input.requestId,fingerprint:digest,...payload,provider:this.config.provider,model:this.config.model,
      status:'queued',createdAt:now(),cursor:0,resultVersion:0,events:[],turns:[],pendingPermissions:[]};
    delete task.prompt;this.addTurn(task,input.prompt,input.requestId);
    this.tasks.set(task.id,task);this.save(task);this.pump();return this.snapshot(task,0,input);
  }
  addTurn(task,prompt,requestId){
    if(task.turns.length>=200)throw new Error('Session turn limit reached; create a new task');
    // The raw prompt is stored for idempotency; the execution contract is
    // composed only when the turn is dispatched.
    const turn={id:randomUUID(),seq:task.turns.length+1,requestId,prompt,status:'queued',output:'',createdAt:now()};
    task.turns.push(turn);return turn;
  }
  continue(input){
    if(this.stopping)throw new Error('Controller is shutting down');
    const task=this.get(input.taskId);
    if(this.closing.has(task.id))throw new Error('Task is closing; wait until closed before continuing');
    const existing=task.turns.find(t=>t.requestId===input.requestId);
    if(existing){if(existing.prompt!==input.prompt)throw new Error('requestId already used for different prompt');return this.snapshot(task,0,{...input,afterResultVersion:String(task.resultVersion??0)});}
    if(task.turns.filter(t=>t.status==='queued').length>=20)throw new Error('Session queue is full');
    this.addTurn(task,input.prompt,input.requestId);task.error=undefined;
    if(!this.active.has(task.id))task.status='queued';this.save(task);this.pump();
    return this.snapshot(task,0,{...input,afterResultVersion:String(task.resultVersion??0)});
  }
  pump(){
    if(this.stopping)return;
    for(const task of this.tasks.values()) {
      if(this.active.size>=this.config.maxConcurrent)break;
      if(this.active.has(task.id)||this.closing.has(task.id)||task.status!=='queued')continue;
      // Serialize one physical workspace; parallel writes require separate directories/worktrees.
      if([...this.active.keys()].some(id=>sameDirectory(this.get(id).cwd,task.cwd)))continue;
      const turn=task.turns.find(t=>t.status==='queued');if(!turn)continue;
      const slot={abort:new AbortController(),turn:null,promise:null};this.active.set(task.id,slot);
      slot.promise=this.run(task,turn,slot).finally(()=>{this.active.delete(task.id);this.emit('change',task.id);this.pump();});
      // The run path reports operational errors into task state; save failures also reach stderr.
      slot.promise.catch(e=>console.error('Task persistence failure:',e.message));
    }
  }
  async run(task,turn,slot){
    task.status='starting';turn.status='running';this.append(task,{type:'turn_started',turnId:turn.id});
    try {
      const ready=await this.backend.ensure(task);task.handle=ready.handle;task.confirmedRoute=ready.route;this.save(task);
      if(slot.abort.signal.aborted)throw new Error('Cancelled before dispatch');
      task.status='running';this.save(task);
      turn.contractId=contractId;
      slot.turn=this.backend.start(task.handle,composeTurnPrompt(turn.prompt),turn.id,slot.abort.signal);
      slot.turn.promptStarted.catch(()=>{});
      for await(const event of slot.turn.events) {
        // Keep hidden model reasoning out of parent output and plugin logs.
        if(event.type==='text_delta') {
          if(event.stream==='thought')continue;
          turn.output+=event.text;
          if(turn.output.length>2_000_000)throw new Error('Task output exceeds 2 MB; cancel and split the task');
          this.append(task,{type:'message',text:clip(event.text,4000)});
        } else if(event.type==='tool_call') {
          this.append(task,{type:'tool',id:event.toolCallId,title:clip(event.title||event.text,600),status:event.status,kind:event.kind,
            locations:event.locations?.slice(0,20)});
        } else if(event.type==='status')this.append(task,{type:'status',text:clip(event.text,600),used:event.used,size:event.size});
      }
      const result=await slot.turn.result;
      turn.status=slot.abort.signal.aborted?'cancelled':result.status;
      turn.stopReason=result.stopReason;
      if(result.detail)turn.error=clip(result.detail);
      if(result.status==='failed')turn.error=clip(result.error.message);
    } catch(error) {
      turn.status=slot.abort.signal.aborted?'cancelled':'failed';turn.error=clip(error.message);
      if(slot.turn)await slot.turn.cancel({reason:'run failed'}).catch(()=>{});
    } finally {
      this.clearPermissions(task.id);
      turn.completedAt=now();task.error=turn.error;
      this.finalizeTurn(task,turn);
      if(turn.status!=='completed') {
        for(const queued of task.turns)if(queued.status==='queued')queued.status='interrupted';
      }
      task.status=task.turns.some(t=>t.status==='queued')?'queued':turn.status;
      this.append(task,{type:'turn_finished',turnId:turn.id,status:turn.status,stopReason:turn.stopReason,error:turn.error});
    }
  }
  async cancel(id){
    const task=this.get(id);
    for(const turn of task.turns)if(turn.status==='queued')turn.status='cancelled';
    const slot=this.active.get(id);
    if(slot){task.status='cancelling';slot.abort.abort();this.clearPermissions(id);this.save(task);
      if(slot.turn)slot.turn.cancel({reason:'Parent requested cancellation'}).catch(e=>console.error('cancel:',e.message));
    } else {if(!terminal.has(task.status))task.status='cancelled';this.save(task);}
    return this.snapshot(task);
  }
  async close(id){
    if(this.closing.has(id))return this.closing.get(id);
    const task=this.get(id);
    const promise=(async()=>{await this.cancel(id);
      const active=this.active.get(id);if(active)await active.promise;
      if(task.handle)await this.backend.close(task.handle);
      task.status='closed';this.save(task);return this.snapshot(task);
    })().finally(()=>{this.closing.delete(id);this.pump();});
    this.closing.set(id,promise);return promise;
  }
  /**
   * Wait for a state worth acting on, or for any observed change in `change`
   * mode. Ordinary text/tool progress still lands on disk and still advances the
   * cursor; it just does not end an actionable wait.
   */
  async wait(id,cursor=0,waitMs=0,{waitFor='actionable',view='compact',afterResultVersion=undefined,limit=EVENT_PAGE_MAX}={}){
    const task=this.get(id);
    const mode=normalizeWaitFor(waitFor);
    if(waitMs>0){
      const startVersion=task.resultVersion??0;
      const timeout=Math.min(waitMs,55000);
      const acknowledged=normalizeVersion(afterResultVersion)??0;
      const actionable=()=>wakeForStatus.has(task.status)||terminal.has(task.status)||(task.resultVersion??0)>acknowledged;
      const changed=()=>task.cursor>cursor||terminal.has(task.status)||wakeForStatus.has(task.status)||(task.resultVersion??0)>startVersion;
      const ready=mode==='change'?changed:actionable;
      if(!ready()){
        await new Promise(resolve=>{const self=this;const onChange=changedId=>{if(changedId===id&&ready())done();};
          const timer=setTimeout(done,timeout);
          function done(){clearTimeout(timer);self.off('change',onChange);resolve();}
          this.on('change',onChange);
          if(ready())done();});
      }
    }
    return this.snapshot(task,cursor,{view,afterResultVersion,limit});
  }
  requestPermission(req,{signal}) {
    const task=[...this.tasks.values()].find(t=>t.handle?.backendSessionId===req.sessionId);
    if(!task||signal.aborted)return Promise.resolve({outcome:'cancel'});
    return new Promise(resolve=>{
      const id=randomUUID();const onAbort=()=>finish({outcome:'cancel'});
      const finish=decision=>{signal.removeEventListener('abort',onAbort);this.permissions.delete(id);
        task.pendingPermissions=task.pendingPermissions.filter(p=>p.id!==id);
        if(task.status==='waiting_permission')task.status='running';this.save(task);resolve(decision);};
      this.permissions.set(id,{taskId:task.id,finish});
      task.pendingPermissions.push({id,title:clip(req.raw.toolCall?.title,1000),kind:req.inferredKind,
        input:clip(JSON.stringify(req.raw.toolCall?.rawInput??{}),6000),options:req.raw.options?.map(o=>({id:o.optionId,kind:o.kind,name:o.name}))});
      task.status='waiting_permission';signal.addEventListener('abort',onAbort,{once:true});this.save(task);
    });
  }
  clearPermissions(id){for(const p of [...this.permissions.values()])if(p.taskId===id)p.finish({outcome:'cancel'});}
  respond(input){const p=this.permissions.get(input.permissionId);if(!p||p.taskId!==input.taskId)throw new Error('Permission request expired or does not belong to task');
    const task=this.get(input.taskId);p.finish({outcome:input.allow?'allow_once':'reject_once'});
    return this.snapshot(task,0,{view:'compact'});}
  async shutdown(){
    this.stopping=true;
    await Promise.allSettled([...this.tasks.keys()].map(id=>this.close(id)));
  }
  async dispatch(method,args={}) {
    switch(method){
      case 'doctor':return {...doctor(this.config),controllerPid:process.pid,activeTasks:this.active.size,version,skippedTaskFiles:this.skippedTaskFiles.length};
      case 'start':return this.start(args);
      case 'continue':return this.continue(args);
      case 'get':return this.wait(args.taskId,args.cursor,args.waitMs,args);
      case 'list':return [...this.tasks.values()].filter(t=>!args.cwd||sameDirectory(path.resolve(args.cwd),t.cwd))
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,args.limit||30).map(t=>({taskId:t.id,title:t.title,cwd:t.cwd,status:t.status,sessionId:t.handle?.backendSessionId,updatedAt:t.updatedAt}));
      case 'cancel':return this.cancel(args.taskId);
      case 'close':return this.close(args.taskId);
      case 'permission':return this.respond(args);
      default:throw new Error('Unknown controller operation');
    }
  }
}
export function normalizeWaitFor(value){
  if(value===undefined||value===null||value==='')return 'actionable';
  if(value!=='actionable'&&value!=='change')throw new Error('waitFor must be actionable or change');
  return value;
}
/** `afterResultVersion` is a string on the wire; accept absent/empty as "unknown". */
export function normalizeVersion(value){
  if(value===undefined||value===null||value==='')return undefined;
  const text=String(value);
  if(!/^\d{1,12}$/.test(text))throw new Error('afterResultVersion must be a non-negative integer string');
  return Number(text);
}
