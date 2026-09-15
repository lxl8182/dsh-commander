/**
 * Verify the built dist/server.mjs bundle itself: imports cleanly, exposes the
 * nine tools with the new protocol parameters, and answers doctor.
 *
 * The run is fully isolated: it uses a temporary DSH_COMMANDER_HOME with its own
 * config file, so it never reads the live configuration, never touches the live
 * controller, and never dispatches a DSH turn. Cleanup addresses that temporary
 * state directory by path (never through the ambient environment) and stops the
 * controller it started before removing anything.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { rpc } from '../src/ipc.mjs';

const root=process.env.DSH_TEST_PLUGIN_ROOT||path.resolve(import.meta.dirname,'..');
const scratch=path.join(os.tmpdir(),'dsh-commander-dist-verify-'+process.pid);
fs.mkdirSync(scratch,{recursive:true});
// An explicit config file keeps the temporary controller on its own state
// directory and IPC pipe even after this script removes it.
fs.writeFileSync(path.join(scratch,'config.json'),JSON.stringify({dshLaunchMode:'npm'}));
const env={...process.env,DSH_COMMANDER_HOME:scratch,DSH_COMMANDER_CONFIG:path.join(scratch,'config.json')};
const evidence={root,mode:'dist',scratch,tools:[],checks:[]};
const client=new Client({name:'dsh-commander-dist-verify',version:'0.1.0'});
function exitSoon(){setTimeout(()=>process.exit(process.exitCode??0),250);}
try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/server.mjs')],env,stderr:'pipe'}));
  evidence.checks.push('dist/server.mjs starts and completes the MCP handshake');
  const listed=await client.listTools();
  assert.equal(listed.tools.length,9,'the bundle exposes the same nine tools');
  const byName=Object.fromEntries(listed.tools.map(tool=>[tool.name,tool]));
  evidence.tools=listed.tools.map(tool=>({name:tool.name,parameters:Object.keys(tool.inputSchema?.properties??{})}));
  for(const name of ['dsh_doctor','dsh_start_task','dsh_get_task','dsh_continue_task','dsh_list_tasks','dsh_cancel_task','dsh_close_task','dsh_respond_permission'])assert.ok(byName[name],`missing tool ${name}`);
  const get=byName.dsh_get_task.inputSchema;
  assert.ok(get.properties.waitFor,'dsh_get_task must expose waitFor');
  assert.deepEqual(get.properties.waitFor.enum,['actionable','change']);
  assert.equal(get.properties.waitFor.default,'actionable');
  assert.ok(get.properties.view,'dsh_get_task must expose view');
  assert.deepEqual(get.properties.view.enum,['compact','events']);
  assert.equal(get.properties.view.default,'compact');
  assert.equal(get.properties.afterResultVersion.type,'string');
  assert.equal(get.properties.limit.maximum,50);
  for(const name of ['dsh_start_task','dsh_continue_task']){
    assert.ok(byName[name].inputSchema.properties.view,`${name} must expose view`);
    assert.equal(byName[name].inputSchema.properties.view.default,'compact');
  }
  evidence.checks.push('dist schemas expose waitFor, view (compact default) and afterResultVersion');
  const doctorReply=await client.callTool({name:'dsh_doctor',arguments:{}},undefined,{timeout:60000});
  assert.equal(doctorReply.isError??false,false,doctorReply.content?.[0]?.text);
  const doctor=JSON.parse(doctorReply.content[0].text);
  assert.equal(doctor.ok,true);
  assert.equal(doctor.stateDir,scratch,'doctor must report the isolated state directory');
  evidence.doctor={version:doctor.version,provider:doctor.provider,model:doctor.model,launchMode:doctor.dshLaunchMode};
  evidence.checks.push('dist controller answers doctor from an isolated state directory');
  // Schema validation must reject an incomplete call before any task is touched.
  // The reply may be an error result or a thrown McpError, and an error result is
  // not guaranteed to carry content, so never index into it unguarded.
  let rejected='';
  try{
    const reply=await client.callTool({name:'dsh_get_task',arguments:{}},undefined,{timeout:30000});
    rejected=(reply.isError&&reply.content?.[0]?.text)||'';
  }catch(error){rejected=error.message;}
  assert.match(rejected,/invalid|required|taskId/i,`an incomplete dsh_get_task call must be rejected, saw: ${rejected||'no error'}`);
  evidence.checks.push('invalid dsh_get_task input is rejected without side effects');
  await client.close();
  evidence.ok=true;
}catch(error){
  evidence.ok=false;evidence.error=error.message;
  process.exitCode=1;
}finally{
  // rpc derives both the pipe name and the control token from stateDir, so the
  // target is built directly from this run's scratch directory. Resolving it from
  // the ambient environment instead would stop the *live* controller and leave
  // this run's own temporary controller running forever.
  const isolated={stateDir:scratch};
  const stopped=await rpc(isolated,'shutdown',{},5000).then(()=>true,()=>false);
  let pipeGone=false;
  for(let attempt=0;attempt<50;attempt+=1){
    try{await rpc(isolated,'ping',{},500);}catch{pipeGone=true;break;}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  await client.close().catch(()=>{});
  // Deleting the state directory destroys the control token, so only do it once
  // the controller living in it is confirmed gone; otherwise the process could
  // never be reached or stopped again.
  try{if(pipeGone)fs.rmSync(scratch,{recursive:true,force:true});}
  catch(error){evidence.scratchRemovalError=error.message;}
  evidence.controller={stopped,pipeGone};
  const report=JSON.stringify(evidence,null,2);
  if(evidence.ok)console.log(report);else console.error(report);
  exitSoon();
}
