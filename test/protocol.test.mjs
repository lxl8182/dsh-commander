import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, flush, waitUntil, deferred, readTurnArtifact, artifactFor } from './helpers.mjs';
import { normalizeVersion, normalizeWaitFor } from '../src/manager.mjs';

const REPORT=(fields)=>['<<<DSH_REPORT>>>',JSON.stringify({outcome:'done',summary:'已实现',changedFiles:['src/a.mjs'],checks:[{command:'node --test',status:'pass',evidence:'12 pass'}],unresolved:[],...fields}),'<<<END_DSH_REPORT>>>'].join('\n');

/* ---------------------------------------------------------------- item 1 */

test('actionable wait ignores message and tool progress but still records it',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1,{label:'turn started'});
  const task=f.manager.get(started.taskId);const turn=f.backend.started[0];
  const beforeVersion=task.resultVersion;
  const pending=f.manager.wait(started.taskId,task.cursor,5000,{waitFor:'actionable'});
  let settled=false;pending.then(()=>{settled=true;});
  turn.text('普通进度');
  turn.push({type:'tool_call',toolCallId:'t1',title:'read file',status:'in_progress',kind:'read'});
  turn.push({type:'status',text:'thinking',used:10,size:100});
  await waitUntil(()=>task.events.some(e=>e.type==='status'),{label:'progress recorded'});
  await flush();
  const progress=task.events.filter(e=>['message','tool','status'].includes(e.type));
  assert.equal(progress.length,3,'ordinary progress is still recorded');
  assert.deepEqual(progress.map(e=>e.type),['message','tool','status']);
  assert.equal(settled,false,'ordinary progress must not end an actionable wait');
  assert.equal(task.resultVersion,beforeVersion);
  turn.complete();
  const result=await pending;
  assert.equal(result.reportState,'returned');
  assert.equal(result.status,'completed');
  assert.ok(result.resultVersion>beforeVersion);
  assert.ok(result.cursor>=3);
});

test('actionable wait returns immediately when it starts on a finished turn',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text(REPORT({}));f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1,{label:'turn finished'});
  const began=Date.now();
  const result=await f.manager.wait(started.taskId,0,5000);
  assert.ok(Date.now()-began<400,'a finished turn is already actionable');
  assert.equal(result.reportOutcome,'done');
});

test('actionable wait wakes on a completed turn even when a follow-up turn is queued behind it',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());const task=f.manager.get(started.taskId);
  await waitUntil(()=>f.backend.started.length===1);
  f.manager.continue({taskId:started.taskId,prompt:'two',requestId:randomUUID()});
  const pending=f.manager.wait(started.taskId,task.cursor,5000,{waitFor:'actionable'});
  let settled=false;pending.then(()=>{settled=true;});
  f.backend.started[0].text(REPORT({summary:'第一轮'}));f.backend.started[0].complete();
  const result=await pending;
  assert.equal(settled,true);
  // The queued turn must not hide the finished turn's result.
  assert.equal(result.status,'queued');
  assert.equal(result.turn.status,'queued');
  assert.equal(result.reportState,'returned');
  assert.equal(result.resultVersion,1);
  assert.equal(result.report.summary,'第一轮');
});

test('actionable wait wakes for a permission prompt and reports it unredacted',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());const task=f.manager.get(started.taskId);
  await waitUntil(()=>f.backend.started.length===1);
  const pending=f.manager.wait(started.taskId,task.cursor,5000,{waitFor:'actionable'});
  const controller=new AbortController();
  const permission=f.permission({sessionId:task.handle.backendSessionId,inferredKind:'execute',
    raw:{toolCall:{title:'run tests',rawInput:{command:'node --test'}},options:[]}},controller.signal);
  const result=await pending;
  assert.equal(result.status,'waiting_permission');
  assert.equal(result.pendingPermissions.length,1);
  assert.match(result.pendingPermissions[0].title,/run tests/);
  assert.equal(result.reportState,'pending');
  const id=result.pendingPermissions[0].id;
  f.manager.respond({taskId:started.taskId,permissionId:id,allow:true});
  assert.deepEqual(await permission,{outcome:'allow_once'});
  f.backend.started[0].complete();
});

test('actionable timeout returns a short status without result body or full history',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  const turn=f.backend.started[0];turn.text('x'.repeat(30000));
  await waitUntil(()=>f.manager.get(started.taskId).turns[0].output.length===30000,{label:'long output'});
  const began=Date.now();
  const result=await f.manager.wait(started.taskId,0,300);
  assert.ok(Date.now()-began>=250,'the timeout must actually wait');
  assert.equal(result.status,'running');
  assert.equal(result.reportState,'pending');
  assert.equal(result.report,null);
  assert.equal(result.finalText,null);
  assert.ok(!('events' in result));
  assert.ok(!('turns' in result));
  assert.ok(JSON.stringify(result).length<4000);
  turn.complete();
});

test('waitFor=change still observes incremental progress',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());const task=f.manager.get(started.taskId);
  await waitUntil(()=>f.backend.started.length===1);
  const cursor=task.cursor;
  const pending=f.manager.wait(started.taskId,cursor,5000,{waitFor:'change',view:'events'});
  f.backend.started[0].text('进度一');
  const result=await pending;
  assert.equal(result.view,'events');
  assert.ok(result.events.some(e=>e.type==='message'));
  assert.equal(result.events[0].seq,cursor+1);
  f.backend.started[0].complete();
});

test('wait option validation rejects unknown modes and versions',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  assert.throws(()=>normalizeWaitFor('terminal'),/waitFor/);
  assert.throws(()=>normalizeVersion('v1'),/afterResultVersion/);
  assert.throws(()=>normalizeVersion('-1'),/afterResultVersion/);
  assert.equal(normalizeWaitFor(undefined),'actionable');
  assert.equal(normalizeVersion(''),undefined);
  assert.equal(normalizeVersion('0'),0);
  f.backend.started[0].text(REPORT({}));f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1);
  await assert.rejects(()=>f.manager.wait(started.taskId,0,250,{afterResultVersion:'v1'}),/afterResultVersion/);
  const result=await f.manager.wait(started.taskId,0,0,{afterResultVersion:'0'});
  assert.equal(result.reportState,'returned');
});

/* ---------------------------------------------------------------- item 2 */

test('compact view never returns the accumulated body, the event page or the whole history',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());const turn=f.backend.started.length?f.backend.started[0]:null;
  assert.equal(turn,null,'start returns before dispatch');
  assert.equal(started.report,null);
  assert.equal(started.finalText,null);
  assert.equal(started.reportState,'pending');
  assert.ok(!('events' in started));
  assert.ok(!('turns' in started));
  assert.ok(!JSON.stringify(started).includes('"prompt"'));
  await waitUntil(()=>f.backend.started.length===1);
  const active=f.backend.started[0];
  const big='日志行 '+ 'y'.repeat(500) + '\n';
  for(let i=0;i<60;i+=1)active.text(big);
  active.text(REPORT({summary:'最终结论',unresolved:['未验证的边界']}));
  active.complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1,{label:'finished'});
  const result=await f.manager.wait(started.taskId,0,0);
  const payload=JSON.stringify(result);
  assert.match(payload,/最终结论/);
  assert.ok(!payload.includes('y'.repeat(501)),'the accumulated body must not be inlined');
  assert.ok(payload.length<20000,`compact payload stayed small: ${payload.length}`);
  const raw=artifactFor(f.stateDir,result);
  assert.match(raw,/y{500}/,'the complete output stays readable in the artifact');
  assert.match(raw,/DSH_REPORT/);
  assert.ok(raw.length>30000,'the full accumulated body is preserved on disk');
  const finalText=fs.readFileSync(result.artifacts.finalText,'utf8');
  assert.ok(finalText.length<raw.length/2,'the returned text is strictly smaller than the full body');
  assert.ok(!finalText.includes('最终结论'),'the conclusion comes from the structured report, not from re-sent text');
  assert.equal(result.report.summary,'最终结论');
  assert.deepEqual(result.unresolved,['未验证的边界']);
  assert.equal(result.resultFallback,false);
});

test('the same resultVersion is delivered once and unknown versions still receive it',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text(REPORT({summary:'交付一次'}));f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1);
  const first=await f.manager.wait(started.taskId,0,0,{});
  assert.equal(first.reportState,'returned');
  assert.match(first.report.summary,/交付一次/);
  const version=String(first.resultVersion);
  const again=await f.manager.wait(started.taskId,first.cursor,0,{afterResultVersion:version});
  assert.equal(again.reportState,'omitted');
  assert.equal(again.report,null);
  assert.equal(again.finalText,null);
  assert.equal(again.reportVersion,first.resultVersion);
  assert.equal(again.artifacts.report,first.artifacts.report,'artifact paths describe the disk, so they survive report-body omission');
  assert.ok(JSON.stringify(again).length<2500,`omitted payload stays small: ${JSON.stringify(again).length}`);
  // A different client never saw the report, so it still receives it: no global read flag.
  const otherClient=await f.manager.wait(started.taskId,0,0,{});
  assert.equal(otherClient.reportState,'returned');
  assert.equal(otherClient.resultVersion,first.resultVersion);
});

test('a failed active turn is readable even after its queued follow-ups are invalidated',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());const task=f.manager.get(started.taskId);
  await waitUntil(()=>f.backend.started.length===1);
  f.manager.continue({taskId:started.taskId,prompt:'two',requestId:randomUUID()});
  const pending=f.manager.wait(started.taskId,task.cursor,5000,{waitFor:'actionable'});
  f.backend.started[0].text('partial evidence before the failure');
  f.backend.started[0].fail('transport lost');
  const result=await pending;
  assert.equal(result.status,'failed');
  assert.equal(result.resultVersion,1);
  assert.equal(result.turn.status,'interrupted');
  assert.equal(result.reportState,'returned');
  assert.equal(result.resultFallback,true);
  assert.equal(result.resultFallbackReason,'report_markers_missing');
  assert.match(result.finalText,/partial evidence/);
  assert.equal(result.turns,undefined);
  const followUp=await f.manager.wait(started.taskId,0,0,{view:'events',limit:50});
  assert.equal(followUp.turns[1].status,'interrupted');
  assert.equal(followUp.turns[1].resultVersion,null);
  assert.equal(followUp.status,'failed');
  assert.equal(followUp.latestCursor,followUp.cursor);
});

test('events view pages forward without skipping and discloses the retention gap',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());const task=f.manager.get(started.taskId);
  await waitUntil(()=>f.backend.started.length===1);
  for(let i=1;i<=250;i+=1)f.manager.append(task,{type:'progress',index:i});
  const base=task.cursor;
  const latest=base;
  assert.equal(task.events.length,200,'the retained window is bounded');
  assert.equal(task.events[0].seq,base-199);
  const seen=[];let cursor=0;let pages=0;let truncated=false;
  while(pages<10){
    const page=await f.manager.wait(started.taskId,cursor,0,{view:'events',limit:50});
    pages+=1;
    assert.ok(page.events.length<=50);
    seen.push(...page.events.map(e=>e.seq));
    truncated=truncated||page.eventsTruncated;
    if(!page.hasMore){assert.equal(page.cursor,page.latestCursor);break;}
    assert.equal(page.cursor,page.events.at(-1).seq);
    cursor=page.cursor;
  }
  assert.equal(pages,4);
  assert.equal(seen.length,200);
  assert.deepEqual(seen,[...Array(200).keys()].map(i=>i+(base-199)));
  assert.equal(new Set(seen).size,seen.length,'no event is delivered twice');
  assert.equal(truncated,true,'the already-evicted head of the log is reported as a gap');
  const head=await f.manager.wait(started.taskId,10,0,{view:'events',limit:50});
  assert.equal(head.events[0].seq,base-199);
  assert.equal(head.eventsDroppedBefore,base-200);
  assert.equal(head.eventsTruncated,true);
  const tail=await f.manager.wait(started.taskId,base,0,{view:'events',limit:50});
  assert.deepEqual(tail.events,[]);
  assert.equal(tail.hasMore,false);
  assert.equal(tail.cursor,base);
  assert.equal(tail.latestCursor,base);
  const artifact=fs.readFileSync(tail.artifacts.events,'utf8').trim().split('\n');
  assert.equal(artifact.length,base,'every event stays on disk');
  assert.equal(JSON.parse(artifact[0]).seq,1);
  f.backend.started[0].complete();
});

test('cursor advances monotonically for ordinary progress so nothing is re-delivered',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());const task=f.manager.get(started.taskId);
  await waitUntil(()=>f.backend.started.length===1);
  const base=task.cursor;
  f.manager.append(task,{type:'progress',index:1});
  const first=await f.manager.wait(started.taskId,base,0,{view:'events'});
  assert.equal(first.cursor,base+1);
  assert.deepEqual(first.events.map(e=>e.index),[1]);
  f.manager.append(task,{type:'progress',index:2});
  const second=await f.manager.wait(started.taskId,first.cursor,0,{view:'events'});
  assert.deepEqual(second.events.map(e=>e.index),[2]);
  assert.equal(second.eventsDroppedBefore,0);
  f.backend.started[0].complete();
});

/* ---------------------------------------------------------------- item 3 */

test('the execution contract is injected into every dispatched turn without touching idempotency',async t=>{
  const f=fixture(t);const requestId=randomUUID();const started=f.manager.start(f.input({requestId,prompt:'只做一件事'}));
  await waitUntil(()=>f.backend.started.length===1);
  const first=f.backend.started[0].prompt;
  assert.match(first,/【DSH 执行约定/);
  assert.match(first,/<<<DSH_REPORT>>>/);
  assert.match(first,/最多再尝试两种有新证据的不同策略/);
  assert.match(first,/不授予任何新权限/);
  assert.match(first,/【任务】\n只做一件事$/);
  assert.equal(first.match(/<<<DSH_REPORT>>>/g).length,1);
  assert.equal(f.manager.get(started.taskId).turns[0].prompt,'只做一件事','the raw prompt is what idempotency compares');
  const repeat=f.manager.start(f.input({requestId,prompt:'只做一件事'}));
  assert.equal(repeat.taskId,started.taskId);
  assert.throws(()=>f.manager.start(f.input({requestId,prompt:'另一件事'})),/already used/);
  f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(started.taskId).status==='completed');
  const followUp=f.manager.continue({taskId:started.taskId,prompt:'继续做第二件事',requestId:randomUUID()});
  await waitUntil(()=>f.backend.started.length===2);
  assert.match(f.backend.started[1].prompt,/【DSH 执行约定/);
  assert.match(f.backend.started[1].prompt,/【任务】\n继续做第二件事$/);
  assert.equal(f.manager.get(followUp.taskId).turns[1].prompt,'继续做第二件事');
  assert.notEqual(f.backend.started[1].id,f.backend.started[0].id);
  f.backend.started[1].complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===2);
  const result=await f.manager.wait(started.taskId,0,0,{afterResultVersion:'1'});
  assert.equal(result.reportState,'returned');
  assert.equal(result.resultVersion,2);
});

test('a real turn produces the parsed report artifact alongside the raw output',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text('实现完成，见下。\n');
  f.backend.started[0].text(REPORT({}));
  f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1);
  const result=await f.manager.wait(started.taskId,0,0,{});
  assert.equal(result.reportOutcome,'done');
  assert.deepEqual(result.report.changedFiles,['src/a.mjs']);
  assert.deepEqual(result.report.checks,[{command:'node --test',status:'pass',evidence:'12 pass'}]);
  assert.equal(result.report.decision,null);
  assert.deepEqual(result.unresolved,[]);
  assert.ok(fs.existsSync(result.artifacts.report));
  assert.equal(JSON.parse(fs.readFileSync(result.artifacts.report,'utf8')).summary,'已实现');
  const artifact=readTurnArtifact(f.stateDir,'实现完成');
  assert.ok(artifact,'the raw output file is kept');
  assert.ok(artifact.text.includes('<<<END_DSH_REPORT>>>'));
  assert.equal(result.turnCount,1);
});
