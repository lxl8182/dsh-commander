import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fixture, waitUntil } from './helpers.mjs';
import { TaskManager } from '../src/manager.mjs';
import { parseTurnReport, fallbackLimit, reportPayloadLimit } from '../src/report.mjs';

const report=(summary)=>`<<<DSH_REPORT>>>\n${JSON.stringify({outcome:'done',summary,changedFiles:[],checks:[],unresolved:[],decision:null})}\n<<<END_DSH_REPORT>>>`;

test('change mode returns an already pending event page without waiting for more events',async t=>{
  const f=fixture(t);const s=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  const task=f.manager.get(s.taskId);const cursor=task.cursor;
  f.manager.append(task,{type:'message',text:'already buffered'});
  const before=Date.now();const page=await f.manager.wait(s.taskId,cursor,800,{view:'events',waitFor:'change'});
  assert.ok(Date.now()-before<400);assert.equal(page.events[0].text,'already buffered');
});

test('an unacknowledged completed result is actionable while the next turn runs',async t=>{
  const f=fixture(t);const s=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text(report('first'));f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(s.taskId).resultVersion===1);
  const next={taskId:s.taskId,prompt:'second',requestId:randomUUID()};
  const reply=f.manager.continue(next);assert.equal(reply.report,null);assert.equal(f.manager.continue(next).report,null);
  await waitUntil(()=>f.backend.started.length===2);
  const before=Date.now();const result=await f.manager.wait(s.taskId,reply.cursor,800,{afterResultVersion:'0'});
  assert.ok(Date.now()-before<400);assert.equal(result.report.summary,'first');assert.equal(result.status,'running');
  const diagnostic=await f.manager.wait(s.taskId,0,0,{view:'events'});
  assert.equal(diagnostic.artifacts.result,result.artifacts.result);
  assert.equal(diagnostic.artifacts.finalText,result.artifacts.finalText);
  assert.equal(fs.readFileSync(diagnostic.artifacts.result,'utf8'),report('first'));
});

test('pre-protocol snapshots recover evidence from the executed turn, not a cancelled queue entry',async t=>{
  const f=fixture(t);const s=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text('legacy final evidence');f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(s.taskId).resultVersion===1);
  const task=f.manager.get(s.taskId);delete task.resultVersion;delete task.resultTurnId;
  for(const key of ['seq','resultVersion','report','finalText'])delete task.turns[0][key];
  task.turns.push({id:randomUUID(),prompt:'never executed',status:'cancelled',output:''});
  f.manager.save(task);
  const restored=new TaskManager(f.config,()=>f.backend);
  const result=restored.snapshot(restored.get(task.id));
  assert.equal(result.resultVersion,1);assert.equal(result.resultTurnId,task.turns[0].id);
  assert.match(result.finalText,/legacy final evidence/);assert.equal(result.resultFallback,true);
});

test('restart publishes partial running evidence as an interrupted result',async t=>{
  const f=fixture(t);const s=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text('partial evidence');
  await waitUntil(()=>f.manager.get(s.taskId).turns[0].output.includes('partial'));
  const restored=new TaskManager(f.config,()=>f.backend);
  const result=restored.snapshot(restored.get(s.taskId));
  assert.equal(result.status,'interrupted');assert.equal(result.resultVersion,1);
  assert.match(result.finalText,/partial evidence/);assert.ok(fs.existsSync(result.artifacts.result));
});

test('oversized or unusable decision reports fail explicitly, and fallback stays small',async t=>{
  assert.equal(parseTurnReport(report('x'.repeat(reportPayloadLimit))).reason,'report_too_large');
  assert.equal(parseTurnReport('<<<DSH_REPORT>>>{"outcome":"decision_required","summary":"ask"}<<<END_DSH_REPORT>>>').reason,'report_decision_missing_question');
  const f=fixture(t);const s=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text('x'.repeat(20000)+'FINAL_EVIDENCE');f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(s.taskId).resultVersion===1);
  const result=f.manager.snapshot(f.manager.get(s.taskId));
  assert.equal(result.finalText.length,fallbackLimit);assert.ok(result.finalText.endsWith('FINAL_EVIDENCE'));
  assert.equal(result.finalTextTruncated,true);assert.ok(fs.readFileSync(result.artifacts.result,'utf8').length>20000);
});

test('a valid final report never inlines preceding progress text',async t=>{
  const f=fixture(t);const s=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text('ordinary progress '.repeat(1000)+report('finished'));f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(s.taskId).resultVersion===1);
  const result=f.manager.snapshot(f.manager.get(s.taskId));
  assert.equal(result.finalText,null);assert.equal(result.report.summary,'finished');
  assert.ok(!JSON.stringify(result).includes('ordinary progress'));
});
