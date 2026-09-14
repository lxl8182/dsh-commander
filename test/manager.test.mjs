import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskManager } from '../src/manager.mjs';
import { validateOperation } from '../src/tools.mjs';

function fixture(t){
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-commander-test-'));
  const config={stateDir,provider:'koazy',model:'deepseek-v4.1-flash',reasoningEffort:'high',maxConcurrent:2};
  const started=[];let permissionHandler;
  const backend={
    async ensure(task){return {handle:{backendSessionId:task.handle?.backendSessionId||randomUUID()},route:'["koazy","deepseek-v4.1-flash"]'};},
    start(handle,text,id,signal){
      let release;const gate=new Promise(r=>release=r);let value={status:'completed',stopReason:'end_turn'};
      const turn={id,text,handle,complete(result=value){value=result;release();},
        promptStarted:Promise.resolve(),result:gate.then(()=>value),
        events:(async function*(){await gate;yield {type:'text_delta',stream:'thought',text:'PRIVATE_REASONING'};yield {type:'text_delta',stream:'output',text:'中文 result '+text};})(),
        async cancel(){value={status:'cancelled'};release();}};
      signal.addEventListener('abort',()=>turn.cancel(),{once:true});started.push(turn);return turn;
    },async close(){},
  };
  const manager=new TaskManager(config,(_c,p)=>{permissionHandler=p;return backend;});
  t.after(async()=>{await manager.shutdown();fs.rmSync(stateDir,{recursive:true,force:true});});
  return {manager,config,started,permission:(...a)=>permissionHandler(...a),backend,
    input(extra={}){return {cwd:stateDir,title:'test',prompt:'one',requestId:randomUUID(),...extra};}};
}
async function until(predicate){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw new Error('test wait deadline');await new Promise(r=>setTimeout(r,5));}}

test('same request retries never duplicate work and conflicting retries fail',async t=>{
  const f=fixture(t);const input=f.input();const a=f.manager.start(input);const b=f.manager.start(input);assert.equal(a.taskId,b.taskId);
  assert.throws(()=>f.manager.start({...input,prompt:'different'}),/already used/);
  await until(()=>f.started.length===1);f.started[0].complete();await until(()=>f.manager.get(a.taskId).status==='completed');
  const task=f.manager.get(a.taskId);assert.equal(task.turns.length,1);assert.ok(!JSON.stringify(task).includes('PRIVATE_REASONING'));
});
test('follow-ups serialize and retain the native session id',async t=>{
  const f=fixture(t);const first=f.manager.start(f.input());await until(()=>f.started.length===1);
  f.manager.continue({taskId:first.taskId,prompt:'two',requestId:'second'});assert.equal(f.started.length,1);
  f.started[0].complete();await until(()=>f.started.length===2);assert.equal(f.started[0].handle.backendSessionId,f.started[1].handle.backendSessionId);
  f.started[1].complete();await until(()=>f.manager.get(first.taskId).status==='completed');
});
test('same workspace is serialized while independent workspaces run concurrently',async t=>{
  const f=fixture(t);const other=path.join(f.config.stateDir,'other');fs.mkdirSync(other);
  f.manager.start(f.input());f.manager.start(f.input());f.manager.start(f.input({cwd:other}));
  await until(()=>f.started.length===2);assert.equal(f.manager.active.size,2);
  f.started[0].complete();f.started[1].complete();await until(()=>f.started.length===3);f.started[2].complete();
});
test('failure suspends queued follow-ups instead of replaying potentially unsafe writes',async t=>{
  const f=fixture(t);const a=f.manager.start(f.input());await until(()=>f.started.length===1);
  f.manager.continue({taskId:a.taskId,prompt:'two',requestId:'second'});
  f.started[0].complete({status:'failed',error:{message:'transport lost'}});
  await until(()=>f.manager.get(a.taskId).status==='failed');assert.equal(f.started.length,1);
  assert.equal(f.manager.get(a.taskId).turns[1].status,'interrupted');
});
test('cancel stops both active work and queued follow-ups',async t=>{
  const f=fixture(t);const a=f.manager.start(f.input());await until(()=>f.started.length===1);
  f.manager.continue({taskId:a.taskId,prompt:'two',requestId:'second'});await f.manager.cancel(a.taskId);
  await until(()=>f.manager.get(a.taskId).status==='cancelled');assert.deepEqual(f.manager.get(a.taskId).turns.map(t=>t.status),['cancelled','cancelled']);
});
test('permission decisions are scoped to the task and can only be used once',async t=>{
  const f=fixture(t);const a=f.manager.start(f.input());await until(()=>f.started.length===1);const controller=new AbortController();
  const p=f.permission({sessionId:f.manager.get(a.taskId).handle.backendSessionId,inferredKind:'execute',raw:{toolCall:{title:'verify',rawInput:{command:'node verify.mjs'}},options:[]}}, {signal:controller.signal});
  const pending=f.manager.get(a.taskId).pendingPermissions[0];assert.equal(f.manager.get(a.taskId).status,'waiting_permission');
  assert.throws(()=>f.manager.respond({taskId:randomUUID(),permissionId:pending.id,allow:true}),/does not belong/);
  f.manager.respond({taskId:a.taskId,permissionId:pending.id,allow:false});assert.deepEqual(await p,{outcome:'reject_once'});
  assert.throws(()=>f.manager.respond({taskId:a.taskId,permissionId:pending.id,allow:true}),/expired/);f.started[0].complete();
});
test('restart marks unfinished work interrupted and does not dispatch it',async t=>{
  const f=fixture(t);const a=f.manager.start(f.input());await until(()=>f.started.length===1);
  const restored=new TaskManager(f.config,()=>f.backend);assert.equal(restored.get(a.taskId).status,'interrupted');assert.equal(restored.active.size,0);
  await f.manager.cancel(a.taskId);
});
test('incremental poll wakes on task completion',async t=>{
  const f=fixture(t);const a=f.manager.start(f.input());await until(()=>f.started.length===1);
  const task=f.manager.get(a.taskId);const pending=f.manager.wait(a.taskId,task.cursor,1000);f.started[0].complete();const result=await pending;
  assert.ok(result.cursor>1);await until(()=>task.status==='completed');
});
test('control schemas reject relative workspaces and oversized polling intervals',()=>{
  assert.throws(()=>validateOperation('start',{cwd:'relative',title:'t',prompt:'p',requestId:'r'}));
  assert.throws(()=>validateOperation('get',{taskId:randomUUID(),waitMs:60000}));
  assert.throws(()=>validateOperation('start',{cwd:os.tmpdir(),title:'t',prompt:'p',requestId:'r',provider:'unapproved'}));
});
test('a closing task rejects new follow-ups until its process is released',async t=>{
  const f=fixture(t);const a=f.manager.start(f.input());await until(()=>f.started.length===1);
  let release;f.backend.close=()=>new Promise(r=>release=r);
  const closing=f.manager.close(a.taskId);await until(()=>Boolean(release));
  assert.throws(()=>f.manager.continue({taskId:a.taskId,prompt:'racing write',requestId:'race'}),/closing/);
  release();await closing;assert.equal(f.manager.get(a.taskId).status,'closed');
  f.backend.close=async()=>{};
});
