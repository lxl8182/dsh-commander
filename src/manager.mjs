import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { atomicJson, doctor, version } from './config.mjs';
import { DshBackend } from './backend.mjs';

const terminal=new Set(['completed','failed','cancelled','interrupted','closed']);
const now=()=>new Date().toISOString();
const fingerprint=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const clip=(value,n=4000)=>String(value??'').slice(0,n);

/** One daemon owns tasks. Disk snapshots survive MCP clients and daemon restarts. */
export class TaskManager extends EventEmitter {
  constructor(config,backendFactory=(c,p)=>new DshBackend(c,p)) {
    super(); this.config=config; this.tasks=new Map(); this.active=new Map(); this.permissions=new Map(); this.closing=new Map(); this.stopping=false;
    fs.mkdirSync(path.join(config.stateDir,'tasks'),{recursive:true});
    this.backend=backendFactory(config,(req,ctx)=>this.requestPermission(req,ctx));
    for(const name of fs.readdirSync(path.join(config.stateDir,'tasks'))) {
      if(!name.endsWith('.json'))continue;
      const task=JSON.parse(fs.readFileSync(path.join(config.stateDir,'tasks',name),'utf8'));
      if(!/^[a-f0-9-]{36}$/.test(task.id))throw new Error('Invalid persisted task id');
      this.tasks.set(task.id,task);
      // Never replay writes automatically after a crash. Resume needs a new instruction.
      if(!terminal.has(task.status)) {
        task.status='interrupted'; task.error='Controller restarted during work. Inspect output and continue explicitly.';
        for(const turn of task.turns)if(!terminal.has(turn.status))turn.status='interrupted';
        task.pendingPermissions=[];this.save(task);
      }
    }
  }
  file(task){return path.join(this.config.stateDir,'tasks',task.id+'.json');}
  save(task){task.updatedAt=now();atomicJson(this.file(task),task);this.emit('change',task.id);}
  get(id){const task=this.tasks.get(id);if(!task)throw new Error('Task not found: '+id);return task;}
  append(task,event){
    const record={seq:++task.cursor,time:now(),...event};
    fs.appendFileSync(path.join(this.config.stateDir,'tasks',task.id+'.events.jsonl'),JSON.stringify(record)+'\n',{mode:0o600});
    task.events.push(record); if(task.events.length>200)task.events.shift();
    this.save(task);
  }
  snapshot(task,cursor=0){
    const latest=task.turns.at(-1);
    return {taskId:task.id,title:task.title,cwd:task.cwd,provider:task.provider,model:task.model,reasoningEffort:task.reasoningEffort,
      status:task.status,sessionId:task.handle?.backendSessionId,confirmedRoute:task.confirmedRoute,
      createdAt:task.createdAt,updatedAt:task.updatedAt,cursor:task.cursor,
      events:task.events.filter(e=>e.seq>cursor).slice(-40),
      eventsTruncated:cursor<Math.max(0,(task.events.at(-40)?.seq??1)-1),
      turns:task.turns.map(t=>({id:t.id,status:t.status,createdAt:t.createdAt,completedAt:t.completedAt,stopReason:t.stopReason,error:t.error})),
      result:clip(latest?.output,16000),resultTruncated:(latest?.output?.length??0)>16000,error:task.error,
      pendingPermissions:task.pendingPermissions,
      artifacts:{task:this.file(task),events:path.join(this.config.stateDir,'tasks',task.id+'.events.jsonl'),result:latest?path.join(this.config.stateDir,'tasks',task.id+'.'+latest.id+'.result.txt'):null}};
  }
  start(input){
    if(this.stopping)throw new Error('Controller is shutting down');
    if(!input.cwd)throw new Error('The current Codex workspace was not resolved; retry the tool call from the active Codex session.');
    const cwd=fs.realpathSync(input.cwd);
    if(!fs.statSync(cwd).isDirectory())throw new Error('cwd must be an existing directory');
    const payload={cwd,title:input.title,prompt:input.prompt,reasoningEffort:input.reasoningEffort||this.config.reasoningEffort};
    const digest=fingerprint(payload);
    const existing=[...this.tasks.values()].find(t=>t.requestId===input.requestId);
    if(existing){if(existing.fingerprint!==digest)throw new Error('requestId already used for different task');return this.snapshot(existing);}
    if([...this.tasks.values()].filter(t=>!terminal.has(t.status)).length>=100)throw new Error('Task queue is full');
    const task={id:randomUUID(),requestId:input.requestId,fingerprint:digest,...payload,provider:this.config.provider,model:this.config.model,
      status:'queued',createdAt:now(),cursor:0,events:[],turns:[],pendingPermissions:[]};
    delete task.prompt;this.addTurn(task,input.prompt,input.requestId);
    this.tasks.set(task.id,task);this.save(task);this.pump();return this.snapshot(task);
  }
  addTurn(task,prompt,requestId){
    if(task.turns.length>=200)throw new Error('Session turn limit reached; create a new task');
    const turn={id:randomUUID(),requestId,prompt,status:'queued',output:'',createdAt:now()};
    task.turns.push(turn);return turn;
  }
  continue(input){
    if(this.stopping)throw new Error('Controller is shutting down');
    const task=this.get(input.taskId);
    if(this.closing.has(task.id))throw new Error('Task is closing; wait until closed before continuing');
    const existing=task.turns.find(t=>t.requestId===input.requestId);
    if(existing){if(existing.prompt!==input.prompt)throw new Error('requestId already used for different prompt');return this.snapshot(task);}
    if(task.turns.filter(t=>t.status==='queued').length>=20)throw new Error('Session queue is full');
    this.addTurn(task,input.prompt,input.requestId);task.error=undefined;
    if(!this.active.has(task.id))task.status='queued';this.save(task);this.pump();return this.snapshot(task);
  }
  pump(){
    if(this.stopping)return;
    for(const task of this.tasks.values()) {
      if(this.active.size>=this.config.maxConcurrent)break;
      if(this.active.has(task.id)||this.closing.has(task.id)||task.status!=='queued')continue;
      // Serialize one physical workspace; parallel writes require separate directories/worktrees.
      if([...this.active.keys()].some(id=>this.get(id).cwd===task.cwd))continue;
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
      slot.turn=this.backend.start(task.handle,turn.prompt,turn.id,slot.abort.signal);
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
      if(result.status==='failed')turn.error=clip(result.error.message);
    } catch(error) {
      turn.status=slot.abort.signal.aborted?'cancelled':'failed';turn.error=clip(error.message);
      if(slot.turn)await slot.turn.cancel({reason:'run failed'}).catch(()=>{});
    } finally {
      this.clearPermissions(task.id);
      turn.completedAt=now();task.error=turn.error;
      fs.writeFileSync(path.join(this.config.stateDir,'tasks',task.id+'.'+turn.id+'.result.txt'),turn.output,{mode:0o600});
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
  async wait(id,cursor=0,waitMs=0){
    const task=this.get(id);
    if(waitMs>0&&!terminal.has(task.status)&&task.status!=='waiting_permission'&&task.cursor<=cursor) {
      await new Promise(resolve=>{const onChange=changed=>{if(changed===id)done();};const timer=setTimeout(done,Math.min(waitMs,55000));
        const self=this;function done(){clearTimeout(timer);self.off('change',onChange);resolve();}this.on('change',onChange);
        if(task.cursor>cursor||terminal.has(task.status))done();});
    }
    return this.snapshot(task,cursor);
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
    p.finish({outcome:input.allow?'allow_once':'reject_once'});return this.snapshot(this.get(input.taskId));}
  async shutdown(){
    this.stopping=true;
    await Promise.allSettled([...this.tasks.keys()].map(id=>this.close(id)));
  }
  async dispatch(method,args={}) {
    switch(method){
      case 'doctor':return {...doctor(this.config),controllerPid:process.pid,activeTasks:this.active.size,version};
      case 'start':return this.start(args);
      case 'continue':return this.continue(args);
      case 'get':return this.wait(args.taskId,args.cursor,args.waitMs);
      case 'list':return [...this.tasks.values()].filter(t=>!args.cwd||path.resolve(args.cwd).toLowerCase()===t.cwd.toLowerCase())
        .sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,args.limit||30).map(t=>({taskId:t.id,title:t.title,cwd:t.cwd,status:t.status,sessionId:t.handle?.backendSessionId,updatedAt:t.updatedAt}));
      case 'cancel':return this.cancel(args.taskId);
      case 'close':return this.close(args.taskId);
      case 'permission':return this.respond(args);
      default:throw new Error('Unknown controller operation');
    }
  }
}
