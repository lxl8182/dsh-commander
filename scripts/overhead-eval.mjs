/**
 * Synthetic wire-overhead comparison for the actionable/compact protocol.
 *
 * This measures PROTOCOL SIZE AND WAKE-UP COUNT ONLY. It is a synthetic
 * scenario, so the numbers are not a real subscription-quota saving and must
 * not be quoted as one. Evidence is written to docs/overhead-eval.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskManager } from '../src/manager.mjs';
import { FakeBackend } from '../test/helpers.mjs';
import { composeTurnPrompt } from '../src/contract.mjs';

const options={progressEvents:300,proseBytes:40000,reportSummaryChars:1200};
const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-overhead-'));
const config={stateDir,provider:'koazy',model:'deepseek-v4.1-flash',reasoningEffort:'high',maxConcurrent:2};
const backend=new FakeBackend();
const manager=new TaskManager(config,()=>backend);
const bytes=value=>Buffer.byteLength(JSON.stringify(value),'utf8');

/**
 * The pre-change snapshot shape: full turn history, the last 40 events of the
 * incremental window, a 16 KB clipped result and every artifact path.
 */
function legacySnapshot(task){
  const latest=task.turns.at(-1);
  return {taskId:task.id,title:task.title,cwd:task.cwd,provider:task.provider,model:task.model,reasoningEffort:task.reasoningEffort,
    status:task.status,sessionId:task.handle?.backendSessionId,confirmedRoute:task.confirmedRoute,
    createdAt:task.createdAt,updatedAt:task.updatedAt,cursor:task.cursor,
    events:task.events.filter(e=>e.seq>0).slice(-40),
    eventsTruncated:0<Math.max(0,(task.events.at(-40)?.seq??1)-1),
    turns:task.turns.map(t=>({id:t.id,status:t.status,createdAt:t.createdAt,completedAt:t.completedAt,stopReason:t.stopReason,error:t.error})),
    result:String(latest?.output??'').slice(0,16000),resultTruncated:(latest?.output?.length??0)>16000,error:task.error,
    pendingPermissions:task.pendingPermissions,
    artifacts:{task:path.join(stateDir,'tasks',task.id+'.json'),events:path.join(stateDir,'tasks',task.id+'.events.jsonl'),
      result:latest?path.join(stateDir,'tasks',task.id+'.'+latest.id+'.result.txt'):null}};
}
const reportText=(summary)=>['<<<DSH_REPORT>>>',JSON.stringify({outcome:'done',summary,changedFiles:['src/a.mjs','src/b.mjs'],
  checks:[{command:'node --test',status:'pass',evidence:'39 pass'},{command:'pnpm build',status:'pass',evidence:'bundles written'}],
  unresolved:['未在生产流量中验证'],decision:null}),'<<<END_DSH_REPORT>>>'].join('\n');

const started=manager.start({cwd:stateDir,title:'overhead',prompt:'合成开销场景',requestId:randomUUID()});
while(!backend.started.length)await new Promise(resolve=>setTimeout(resolve,5));
const task=manager.get(started.taskId);
const turn=backend.started[0];
let measuredActionableReturns=0;
const actionableWait=manager.wait(started.taskId,task.cursor,55000,{waitFor:'actionable'}).then(value=>{measuredActionableReturns+=1;return value;});

// Count every change signal the controller emits; the old poll loop treated
// each one as a reason to wake the parent agent.
let signals=0;let actionableSignals=0;
const previousVersion=()=>task.resultVersion??0;
let lastVersion=0;let lastStatus=task.status;
manager.on('change',id=>{
  if(id!==task.id)return;
  signals+=1;
  const statusChanged=task.status!==lastStatus;
  const versionChanged=previousVersion()!==lastVersion;
  lastStatus=task.status;lastVersion=previousVersion();
  // Mirrors TaskManager.wait: only an ended turn or a permission prompt is
  // actionable; ordinary progress is recorded but must not wake the parent.
  if((statusChanged&&['waiting_permission','completed','failed','cancelled','interrupted','closed'].includes(task.status))||versionChanged)actionableSignals+=1;
});

const prose='日志行：正在读取文件并运行校验，'+'z'.repeat(180)+'\n';
for(let i=0;i<options.progressEvents;i+=1){
  const kind=i%3;
  if(kind===0)turn.text(prose);
  else if(kind===1)turn.push({type:'tool_call',toolCallId:'t'+i,title:'run node --test (batch '+i+')',status:'in_progress',kind:'execute'});
  else turn.push({type:'status',text:'progress '+i,used:i,size:options.progressEvents});
}
turn.text(prose.repeat(150)); // pushes the accumulated body well past the inline limit
turn.text(reportText('合成结论 '+ 's'.repeat(options.reportSummaryChars)));
while((task.turns[0].output?.length??0)<options.proseBytes)await new Promise(resolve=>setTimeout(resolve,5));
turn.text('结束');
turn.complete();
while((task.resultVersion??0)<1)await new Promise(resolve=>setTimeout(resolve,5));

const legacy=legacySnapshot(task);
const compactReturned=await actionableWait;
const compactVersion=String(compactReturned.resultVersion);
const compactOmitted=await manager.wait(started.taskId,0,0,{afterResultVersion:compactVersion});
const rawResult=fs.readFileSync(compactReturned.artifacts.result,'utf8');

const evidence={
  generatedAt:new Date().toISOString(),
  disclaimer:'Synthetic protocol comparison. UTF-8 byte counts and observed manager returns, not real subscription-quota savings. Legacy snapshot models an initial cursor=0 read; change signals are wake opportunities, not measured parent model turns.',
  scenario:{progressEvents:options.progressEvents,rawResultCharacters:rawResult.length},
  contractPreambleCharacters:composeTurnPrompt('').length,
  wire:{
    legacyCompactResponseBytes:bytes(legacy),
    newCompactResponseBytes:bytes(compactReturned),
    newOmittedResponseBytes:bytes(compactOmitted),
    finalTextReturnedCharacters:compactReturned.finalText?.length??0,
    rawResultCharacters:rawResult.length,
  },
  wakeups:{
    measuredActionableReturns,
    observedChangeSignals:signals,
    actionableSignalWakesDuringTurn:actionableSignals,
    note:'Change signals are measured potential wake sources. They are not actual legacy MCP polling calls or Astra turns. measuredActionableReturns counts the real new wait invocation in this synthetic backend.',
  },
};
evidence.comparison={
  legacyVsNewBytesRatio:Number((evidence.wire.legacyCompactResponseBytes/Math.max(1,evidence.wire.newCompactResponseBytes)).toFixed(2)),
  newOmittedVsLegacyRatio:Number((evidence.wire.newOmittedResponseBytes/Math.max(1,evidence.wire.legacyCompactResponseBytes)).toFixed(4)),
};
await manager.shutdown();
fs.rmSync(stateDir,{recursive:true,force:true});

const outDir=path.join(import.meta.dirname,'..','docs');
fs.mkdirSync(outDir,{recursive:true});
fs.writeFileSync(path.join(outDir,'overhead-eval.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
