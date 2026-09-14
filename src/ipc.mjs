import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { pipePath, pluginRoot } from './config.mjs';

export function controlToken(config){
  fs.mkdirSync(config.stateDir,{recursive:true});
  const file=path.join(config.stateDir,'control.token');
  try{fs.writeFileSync(file,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
  return fs.readFileSync(file,'utf8').trim();
}
export function rpc(config,method,args={},timeoutMs=65000){
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(pipePath(config));let buffer='';let settled=false;const decoder=new StringDecoder('utf8');
    const timer=setTimeout(()=>finish(new Error('Controller request timed out. For start/continue, retry with the same requestId.')),timeoutMs);
    function finish(error,result){if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(result);}
    socket.on('error',e=>finish(e));
    socket.on('connect',()=>socket.write(JSON.stringify({token:controlToken(config),method,args})+'\n'));
    socket.on('data',data=>{buffer+=decoder.write(data);if(buffer.length>4_000_000)return finish(new Error('Controller response too large'));
      const end=buffer.indexOf('\n');if(end<0)return;try{const reply=JSON.parse(buffer.slice(0,end));finish(reply.error?new Error(reply.error):null,reply.result);}catch(e){finish(e);}});
    socket.on('end',()=>{if(!buffer.includes('\n'))finish(new Error('Controller disconnected before response'));});
  });
}
let startup;
/** Background ownership is independent of the lifetime of an MCP connection. */
export async function ensureDaemon(config){
  if(startup)return startup;
  startup=(async()=>{
    try {await rpc(config,'ping',{},1500);return;} catch(e) {if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}
    controlToken(config);
    const log=fs.openSync(path.join(config.stateDir,'daemon.log'),'a',0o600);
    const child=spawn(process.execPath,[path.join(pluginRoot,'dist/daemon.mjs')],{
      cwd:pluginRoot,detached:true,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,DSH_COMMANDER_HOME:config.stateDir,DSH_COMMANDER_CONFIG:config.configPath},
    });
    let spawnError;child.once('error',e=>{spawnError=e;});child.unref();fs.closeSync(log);
    const until=Date.now()+15000;
    while(Date.now()<until){if(spawnError)throw spawnError;try{await rpc(config,'ping',{},1000);return;}catch(e){if(!['ENOENT','ECONNREFUSED'].includes(e.code))throw e;}await new Promise(r=>setTimeout(r,200));}
    throw new Error(`Controller failed to start. See ${path.join(config.stateDir,'daemon.log')}`);
  })().finally(()=>{startup=undefined;});return startup;
}
