import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
const cli=process.env.CODEX_TEST_CLI||path.join(os.homedir(),'AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js');
const proc=spawn(process.execPath,[cli,'app-server','--stdio'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
let seq=0;const pending=new Map();let stderr='';
proc.stderr.on('data',d=>{stderr=(stderr+d.toString()).slice(-20000);});
const lines=createInterface({input:proc.stdout});
lines.on('line',line=>{try{const msg=JSON.parse(line);if(msg.id!==undefined&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}}catch{}});
function request(method,params){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(method+' timed out'));},90000);pending.set(id,{resolve,reject,timer});proc.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}
try{
  await request('initialize',{clientInfo:{name:'dsh_commander_verifier',version:'0.1.0'},capabilities:{experimentalApi:true}});
  proc.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'initialized'})+'\n');
  const result=await request('mcpServerStatus/list',{limit:100});
  const entries=result.data||result.servers||[];
  const selected=entries.filter(x=>JSON.stringify(x.name||x.serverName||'').includes('dsh'));
  console.log(JSON.stringify({dshServers:selected.map(s=>({name:s.name,serverInfo:s.serverInfo,tools:Object.keys(s.tools||{}),authStatus:s.authStatus})),totalServers:entries.length},null,2));
  if(!selected.some(s=>Object.keys(s.tools||{}).some(n=>n.includes('dsh_start_task'))))throw new Error('Installed Codex did not discover DSH Commander tools');
}catch(e){console.error(e.message);console.error(stderr.split('\n').filter(l=>/dsh|commander/i.test(l)).join('\n'));process.exitCode=1;}
finally{for(const p of pending.values())clearTimeout(p.timer);proc.stdin.end();lines.close();setTimeout(()=>proc.kill(),1000).unref();}
