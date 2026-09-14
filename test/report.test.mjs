import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, waitUntil } from './helpers.mjs';
import { contractText, composeTurnPrompt, contractId } from '../src/contract.mjs';
import { clipFinalText, finalTextLimit, parseTurnReport } from '../src/report.mjs';

const begin='<<<DSH_REPORT>>>';
const end='<<<END_DSH_REPORT>>>';
const payload=(fields={})=>JSON.stringify({outcome:'done',summary:'摘要',changedFiles:['src/a.mjs'],checks:[],unresolved:[],...fields});
const block=(fields={})=>`${begin}\n${payload(fields)}\n${end}`;

test('a complete report block with correct field types is accepted',()=>{
  const parsed=parseTurnReport(`正文\n${block({
    outcome:'decision_required',
    summary:' 需要决定 ',
    changedFiles:['a.mjs','b/c.mjs'],
    checks:[{command:'node --test',status:'pass',evidence:'30 pass'},{command:'pnpm build',status:'not_run'}],
    unresolved:['边界未覆盖'],
    decision:{question:'选择哪种实现？',options:['A','B'],recommendation:'A'}})}\n尾注`);
  assert.equal(parsed.reason,null);
  assert.equal(parsed.report.outcome,'decision_required');
  assert.equal(parsed.report.summary,' 需要决定 ');
  assert.deepEqual(parsed.report.changedFiles,['a.mjs','b/c.mjs']);
  assert.deepEqual(parsed.report.checks,[{command:'node --test',status:'pass',evidence:'30 pass'},{command:'pnpm build',status:'not_run',evidence:''}]);
  assert.deepEqual(parsed.report.unresolved,['边界未覆盖']);
  assert.deepEqual(parsed.report.decision,{question:'选择哪种实现？',options:['A','B'],recommendation:'A'});
  assert.equal(parsed.report.extraText,'尾注');
});

test('optional fields may be absent and malformed input never throws',()=>{
  const minimal=parseTurnReport(`${begin}\n${JSON.stringify({outcome:'done',summary:'ok'})}\n${end}`);
  assert.equal(minimal.report.outcome,'done');
  assert.deepEqual(minimal.report.changedFiles,[]);
  assert.deepEqual(minimal.report.checks,[]);
  assert.deepEqual(minimal.report.unresolved,[]);
  assert.equal(minimal.report.decision,null);
  const cases=[
    [null,'report_markers_missing'],
    ['普通文字，没有报告','report_markers_missing'],
    [`${begin}\n${payload()}`,'report_truncated'],
    [`${begin}\n{"outcome":"done","summary":"s"`,'report_truncated'],
    [`${begin}\nnot json\n${end}`,'report_json_invalid'],
    [`${begin}\n[1,2,3]\n${end}`,'report_not_an_object'],
    [`${begin}\n"done"\n${end}`,'report_not_an_object'],
    [`${begin}\n${payload({outcome:'success'})}\n${end}`,'report_outcome_invalid'],
    [`${begin}\n${payload({outcome:null})}\n${end}`,'report_outcome_invalid'],
    [`${begin}\n${payload({summary:42})}\n${end}`,'report_summary_invalid'],
    [`${begin}\n${payload({changedFiles:'a.mjs'})}\n${end}`,'report_changedFiles_invalid'],
    [`${begin}\n${payload({changedFiles:['a.mjs',7]})}\n${end}`,'report_changedFiles_invalid'],
    [`${begin}\n${payload({checks:{command:'x'}})}\n${end}`,'report_checks_invalid'],
    [`${begin}\n${payload({checks:[{command:'x',status:'maybe'}]})}\n${end}`,'report_checks_invalid'],
    [`${begin}\n${payload({checks:['node --test']})}\n${end}`,'report_checks_invalid'],
    [`${begin}\n${payload({unresolved:'none'})}\n${end}`,'report_unresolved_invalid'],
    [`${begin}\n${payload({decision:'ask'})}\n${end}`,'report_decision_invalid'],
    [`${begin}\n${payload({decision:{options:'A'}})}\n${end}`,'report_decision_invalid'],
    [`${begin}\n${payload()}\n${end}\n${begin}\n${payload()}\n${end}`,'report_ambiguous_multiple_blocks'],
  ];
  for(const [input,reason] of cases){
    const parsed=parseTurnReport(input);
    assert.equal(parsed.report,null,`${reason} must not produce a report`);
    assert.equal(parsed.reason,reason);
  }
});

test('two report blocks are rejected instead of quietly picking one',()=>{
  const older=block({summary:'旧结论'});
  const newer=block({summary:'新结论'});
  const parsed=parseTurnReport(`${older}\n${newer}`);
  assert.equal(parsed.report,null);
  assert.equal(parsed.reason,'report_ambiguous_multiple_blocks');
  const incompleteFirst=`${begin}\n${payload({summary:'旧的没写完'})}\n${newer}`;
  assert.equal(parseTurnReport(incompleteFirst).report,null);
  assert.equal(parseTurnReport(incompleteFirst).reason,'report_ambiguous_multiple_blocks');
  const single=parseTurnReport(`正文\n${newer}\n尾注`);
  assert.equal(single.report.summary,'新结论');
  assert.equal(single.report.extraText,'尾注');
});

test('the returned text stays bounded and clipping keeps the trailing report',()=>{
  const newer=block({summary:'新结论'});
  const huge='x'.repeat(finalTextLimit*3)+newer;
  const clipped=clipFinalText(huge);
  assert.equal(clipped.truncated,true);
  assert.equal(clipped.fullLength,huge.length);
  assert.ok(clipped.text.length<=finalTextLimit);
  assert.equal(parseTurnReport(clipped.text).report.summary,'新结论','clipping from the front keeps the trailing report');
});

test('the injected contract stays short and repeats no rules',()=>{
  const composed=composeTurnPrompt('原始任务');
  assert.ok(composed.length<2000,`contract stays small: ${composed.length}`);
  assert.equal(contractId,'dsh-commander/v1');
  assert.ok(contractText.includes(begin)&&contractText.includes(end));
  assert.equal(contractText.split(begin).length-1,1);
  assert.ok(composed.endsWith('【任务】\n原始任务'));
});

test('fragmented report text is reassembled before parsing and never fakes success',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  const turn=f.backend.started[0];
  const whole=`前言\n${block({summary:'跨分片结论',outcome:'blocked',unresolved:['缺少凭据']})}\n`;
  const chunks=[];for(let i=0;i<whole.length;i+=7)chunks.push(whole.slice(i,i+7));
  for(const chunk of chunks)turn.text(chunk);
  turn.complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1);
  const result=await f.manager.wait(started.taskId,0,0,{});
  assert.equal(result.report.outcome,'blocked');
  assert.equal(result.report.summary,'跨分片结论');
  assert.deepEqual(result.unresolved,['缺少凭据']);
  assert.equal(result.resultFallback,false);
});

test('a truncated final report falls back to a labelled tail excerpt',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  const turn=f.backend.started[0];
  turn.text('前文证据：node --test 通过\n');
  turn.text(`${begin}\n{"outcome":"done","summary":"没写完`);
  turn.complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1);
  const result=await f.manager.wait(started.taskId,0,0,{});
  assert.equal(result.report,null);
  assert.equal(result.reportState,'returned');
  assert.equal(result.resultFallback,true);
  assert.equal(result.resultFallbackReason,'report_truncated');
  assert.match(result.finalText,/前文证据/);
  assert.match(result.finalText,new RegExp(begin));
  const full=fs.readFileSync(result.artifacts.result,'utf8');
  assert.equal(full.includes(end),false);
  assert.equal(result.reportOutcome,null);
});

test('a run without any output is reported as failed evidence, not as success',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].fail('provider refused the route');
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1);
  const result=await f.manager.wait(started.taskId,0,0,{});
  assert.equal(result.status,'failed');
  assert.equal(result.report,null);
  assert.equal(result.reportOutcome,null);
  assert.equal(result.resultFallback,true);
  assert.equal(result.resultFallbackReason,'turn_failed_without_output');
  assert.match(result.error,/provider refused/);
  assert.ok(fs.existsSync(result.artifacts.result));
});

test('report artifacts are written next to the raw output and are not exposed by compact view twice',async t=>{
  const f=fixture(t);const started=f.manager.start(f.input());await waitUntil(()=>f.backend.started.length===1);
  f.backend.started[0].text(`${begin}\n${payload({summary:'一次'})}\n${end}`);
  f.backend.started[0].complete();
  await waitUntil(()=>f.manager.get(started.taskId).resultVersion===1);
  const first=await f.manager.wait(started.taskId,0,0,{});
  assert.ok(fs.existsSync(first.artifacts.report));
  assert.ok(first.artifacts.report.endsWith('.report.json'));
  assert.ok(first.artifacts.finalText.endsWith('.final.txt'));
  assert.equal(path.dirname(first.artifacts.result),path.join(f.stateDir,'tasks'));
  const second=await f.manager.wait(started.taskId,0,0,{afterResultVersion:String(first.resultVersion)});
  assert.equal(second.artifacts.result,first.artifacts.result,'artifact paths remain available when the report is omitted');
});
