/** Owner-local live smoke: no model tools or filesystem writes beyond this evidence. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.mjs';
import { DshWebBackend } from '../src/web-backend.mjs';
const config={...loadConfig(),dshWebUrl:process.env.DSH_WEB_URL??'http://127.0.0.1:3080',turnTimeoutMs:180000};
const cwd=path.resolve(process.argv[2]??process.cwd());
const out=path.join(cwd,'output/playwright');fs.mkdirSync(out,{recursive:true});
const backend=new DshWebBackend(config,async()=>({outcome:'reject_once'}));
const task={id:randomUUID(),cwd,title:'Commander 工作区与流式验收',provider:config.provider,model:config.model,reasoningEffort:config.reasoningEffort};
const evidence={startedAt:new Date().toISOString()};let handle,observer;
try{
  ({handle}=await backend.ensure(task));evidence.handle=handle;
  fs.writeFileSync(path.join(out,'web-smoke-handle.json'),JSON.stringify(handle,null,2));
  console.log(JSON.stringify({ready:true,sessionId:handle.backendSessionId,workspaceId:handle.workspaceId}));
  observer=backend.transport.stream('session/follow',{request:{address:{kind:'session',sessionId:handle.backendSessionId},assistantStream:true,maxMessages:1}});
  await observer.ready;
  let transient=0,beforeDurable=0,durable=false;const frameTypes=new Set();
  const observing=(async()=>{for await(const frame of observer.events){frameTypes.add(frame.type);if(frame.type==='assistant-stream'){transient++;if(!durable)beforeDurable++;}if(frame.type==='event'&&frame.event.type==='assistant/message')durable=true;}})();
  const turn=backend.start(handle,'这是本地界面验收。不要调用工具，不要读写文件或联网。请直接输出 60 行，每行是「流式验收第 N 行：DSH Web 正在同一会话中实时显示内容。」N 从 1 到 60。最后单独一行输出 DSH_WEB_STREAM_OK。',randomUUID());
  let output='';for await(const event of turn.events)if(event.type==='text_delta')output+=event.text;
  const result=await turn.result;await observer.close();await observing;
  evidence.result=result;evidence.stream={transient,beforeDurable,frameTypes:[...frameTypes]};evidence.outputChars=output.length;
  console.log(JSON.stringify({result,stream:evidence.stream,outputChars:output.length}));
  assert.equal(result.status,'completed');assert.match(output,/DSH_WEB_STREAM_OK/);assert.ok(beforeDurable>1,'must see multiple live frames before durable assistant text');
  const groups=backend.transport.stream('workspace/follow',{});
  try{const baseline=await groups.ready;const workspace=baseline.value.items.find(w=>w.workspaceId===handle.workspaceId);assert.ok(workspace.sessionIds.includes(handle.backendSessionId));evidence.group={path:workspace.path,sessionRegistered:true};}finally{await groups.close();}
  const resumed=await backend.ensure({...task,handle});assert.equal(resumed.handle.backendSessionId,handle.backendSessionId);
  const followup=backend.start(resumed.handle,'不要调用工具。仅复述上一轮最后一行的验收标记。',randomUUID());
  let continued='';for await(const event of followup.events)if(event.type==='text_delta')continued+=event.text;
  assert.equal((await followup.result).status,'completed');assert.match(continued,/DSH_WEB_STREAM_OK/);evidence.continuation=true;
  console.log(JSON.stringify({ok:true,group:evidence.group,continuation:true}));
}catch(error){evidence.error=error.message;throw error;}finally{
  await observer?.close();if(handle)await backend.close(handle);
  evidence.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'web-smoke-evidence.json'),JSON.stringify(evidence,null,2));
}
