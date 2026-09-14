/** Owner-local DSH Web RPC and stream transport. Credentials never cross loopback. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import YAML from 'yaml';
import WebSocket from 'ws';

export function localWebUrl(value){
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
    ||url.username||url.password||url.pathname!=='/'||url.search||url.hash){
    throw new Error('dshWebUrl must be a loopback HTTP(S) origin without credentials, query or path');
  }
  return url;
}

/** Use only this DSH home's owner browser-session grant; never create or replace it. */
export function ownerCookie(dshHome,url,now=Date.now()){
  const origin=localWebUrl(url);
  let document;
  try{document=YAML.parse(fs.readFileSync(path.join(dshHome,'.credentials.yaml'),'utf8'));}
  catch{throw new Error('Cannot read DSH owner browser-session grant; start DSH Web using the configured dshHome');}
  const grant=document?.records?.['client-connection/browser-session'];
  const secret=grant?.payload?.secret;
  if(grant?.kind!=='grant'||grant.payload.version!==1||typeof secret!=='string'||!/^[A-Za-z0-9_-]+$/.test(secret)
    ||Buffer.from(secret,'base64url').length!==32){throw new Error('DSH owner browser-session grant is missing or unsupported');}
  const body=Buffer.from(JSON.stringify({version:1,authority:origin.host,issuedAt:now,expiresAt:now+300000})).toString('base64url');
  const signature=createHmac('sha256',Buffer.from(secret,'base64url')).update(body).digest('base64url');
  return `dsh-auth-${createHash('sha256').update(origin.host).digest('base64url')}=v1.${body}.${signature}`;
}

export class AsyncQueue {
  constructor(){this.items=[];this.waiters=[];this.ended=false;this.error=null;}
  push(value){if(this.ended)return;const waiter=this.waiters.shift();if(waiter)waiter.resolve({done:false,value});else this.items.push(value);}
  end(error){if(this.ended)return;this.ended=true;this.error=error;for(const waiter of this.waiters.splice(0))error?waiter.reject(error):waiter.resolve({done:true});}
  next(){if(this.items.length)return Promise.resolve({done:false,value:this.items.shift()});if(this.ended)return this.error?Promise.reject(this.error):Promise.resolve({done:true});return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));}
  [Symbol.asyncIterator](){return this;}
}

export class DshWebTransport {
  constructor(config){this.config=config;this.url=localWebUrl(config.dshWebUrl);}
  async rpc(endpoint,args={},signal){
    let response;const rpcId=randomUUID();
    try{response=await fetch(new URL('/api/'+endpoint,this.url),{method:'POST',redirect:'error',
      headers:{'content-type':'application/json',cookie:ownerCookie(this.config.dshHome,this.url.href)},
      body:JSON.stringify({type:'client-request',rpcId,method:endpoint,payload:{args}}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000)});}
    catch(error){throw new Error(`DSH Web ${endpoint} failed (${error.name}); confirm the configured Web service is running`);}
    if(!response.ok)throw new Error(`DSH Web ${endpoint}: HTTP ${response.status}; check server and owner authentication`);
    const envelope=await response.json();
    if(envelope.type!=='server-response'||envelope.rpcId!==rpcId)throw new Error('Invalid DSH Web RPC response');
    const result=envelope.result;
    if(!result?.ok)throw new Error(`DSH Web ${endpoint}: ${result?.error?.code??'error'}: ${result?.error?.message??'request rejected'}`);
    return result.value;
  }
  request(endpoint,request,signal){return this.rpc(endpoint,{request},signal);}
  stream(endpoint,args){
    const url=new URL('/api/remote.mux',this.url);url.protocol=url.protocol==='https:'?'wss:':'ws:';
    const streamId=randomUUID(),events=new AsyncQueue();let intentional=false,settled=false,resolveReady,rejectReady;
    const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});ready.catch(()=>{});
    const socket=new WebSocket(url,{headers:{Cookie:ownerCookie(this.config.dshHome,this.url.href)},followRedirects:false,handshakeTimeout:15000});
    const fail=error=>{if(!settled){settled=true;rejectReady(error);}events.end(error);};
    socket.on('open',()=>socket.send(JSON.stringify({type:'open',streamId,endpoint,payload:{args}})));
    socket.on('message',data=>{
      try{
        const message=JSON.parse(data.toString());if(message.streamId!==streamId)return;
        if(message.type==='error')throw new Error(`DSH stream ${endpoint}: ${message.error?.code??'error'}`);
        if(message.type==='end'){if(!settled)fail(new Error(`DSH stream ${endpoint} ended before ready`));else events.end();socket.close();return;}
        if(message.type!=='item')throw new Error('Unknown DSH stream frame');
        if(!settled){settled=true;resolveReady(message.value);}events.push(message.value);
      }catch(error){fail(error);socket.close();}
    });
    socket.on('error',()=>fail(new Error(`DSH Web stream ${endpoint} disconnected; work may continue in the Web UI`)));
    socket.on('close',()=>intentional?events.end():fail(new Error(`DSH Web stream ${endpoint} closed; inspect before retrying writes`)));
    const timer=setTimeout(()=>{fail(new Error(`DSH stream ${endpoint} opening timed out`));socket.terminate();},15000);
    ready.then(()=>clearTimeout(timer),()=>clearTimeout(timer));
    return {ready,events,close:async()=>{
      intentional=true;clearTimeout(timer);if(!settled){settled=true;rejectReady(new Error('Stream closed before ready'));}events.end();
      if(socket.readyState===WebSocket.CLOSED)return;
      await new Promise(resolve=>{const fallback=setTimeout(()=>socket.terminate(),1000);socket.once('close',()=>{clearTimeout(fallback);resolve();});socket.close();});
    }};
  }
}
