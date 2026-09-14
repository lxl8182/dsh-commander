import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskManager } from '../src/manager.mjs';

export const flush=async()=>{for(let i=0;i<4;i+=1)await new Promise(resolve=>setImmediate(resolve));};
export async function waitUntil(predicate,label='condition',timeoutMs=3000){
  const deadline=Date.now()+timeoutMs;
  while(!predicate()){if(Date.now()>deadline)throw new Error('test deadline: '+label);await new Promise(resolve=>setTimeout(resolve,5));}
}
export function deferred(){let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej;});return {promise,resolve,reject};}

/**
 * Backend double whose event stream is fully driven by the test. This is what
 * lets the wait/version tests assert on real manager behaviour instead of on
 * source text.
 */
export class FakeBackend {
  constructor(){
    this.started=[];this.closed=[];
    this._resolveEnsure=()=>true;
    this.ensureGate=null;
  }
  async ensure(task){
    const gate=this.ensureGate;
    if(gate)await gate.promise;
    return {handle:{backendSessionId:task.handle?.backendSessionId||randomUUID()},route:'["koazy","deepseek-v4.1-flash"]'};
  }
  start(handle,text,id,signal){
    const turn=new FakeTurn(this,handle,text,id);
    this.started.push(turn);
    signal.addEventListener('abort',()=>turn.cancel(),{once:true});
    return turn;
  }
  async close(handle){this.closed.push(handle);}
}

export class FakeTurn {
  constructor(backend,handle,prompt,id){
    this.backend=backend;this.handle=handle;this.prompt=prompt;this.id=id;
    this.queue=[];this.waiter=null;this.done=false;
    this.resultDeferred=deferred();
    this.promptStarted=Promise.resolve();
    this.cancelDeferred=deferred();
  }
  get result(){return this.resultDeferred.promise;}
  /** Same shape the ACP runtime exposes: a turn carries an async event stream. */
  get events(){return this._pump();}
  async *_pump(){
    while(true){
      const item=this.queue.length?this.queue.shift():await new Promise(resolve=>{this.waiter=resolve;});
      if(item.done)return;
      yield item.value;
    }
  }
  _emit(value){
    if(this.waiter){const resolve=this.waiter;this.waiter=null;resolve(value);}else this.queue.push(value);
  }
  _end(){this.done=true;this._emit({done:true,value:undefined});}
  push(event){this._emit({done:false,value:event});}
  text(value,stream='output'){this.push({type:'text_delta',stream,text:value});}
  complete(result={status:'completed',stopReason:'end_turn'}){this.resultDeferred.resolve(result);this._end();}
  fail(message='transport lost'){this.resultDeferred.resolve({status:'failed',stopReason:'error',error:{message}});this._end();}
  cancel(){this._end();this.resultDeferred.resolve({status:'cancelled'});this.cancelDeferred.resolve();this.backend?.turnCancelled?.(this);}
}

export function fixture(t,{config={}}={}){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-commander-protocol-'));
  const fullConfig={stateDir,provider:'koazy',model:'deepseek-v4.1-flash',reasoningEffort:'high',maxConcurrent:2,...config};
  const backend=new FakeBackend();
  let permissionHandler;
  const manager=new TaskManager(fullConfig,(_c,handler)=>{permissionHandler=handler;return backend;});
  t.after(async()=>{await manager.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  return {manager,backend,config:fullConfig,stateDir,
    permission:(req,signal)=>permissionHandler(req,{signal}),
    input(extra={}){return {cwd:stateDir,title:'test',prompt:'one',requestId:randomUUID(),...extra};}};
}

/** Read the raw output artifact of a turn containing `probe`, proving the full body stays on disk. */
export function readTurnArtifact(stateDir,probe){
  const files=fs.readdirSync(path.join(stateDir,'tasks')).filter(name=>name.endsWith('.result.txt'));
  for(const name of files){
    const text=fs.readFileSync(path.join(stateDir,'tasks',name),'utf8');
    if(text.includes(probe))return {name,text};
  }
  return null;
}
export function artifactFor(stateDir,snapshot){return fs.readFileSync(snapshot.artifacts.result,'utf8');}
