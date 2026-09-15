import path from 'node:path';
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from 'acpx/runtime';
import { agentCommand, doctor, routeField } from './config.mjs';
import { DshWebBackend } from './web-backend.mjs';

/** Explicit Web routing never falls back to an invisible ACP process. */
export function createBackend(config,onPermission){
  return config.dshBackend==='web'?new DshWebBackend(config,onPermission):new DshBackend(config,onPermission);
}

/** Route bookkeeping lives on the handle but must never reach ACPX itself. */
const ROUTE_HANDLE_KEYS=['acpProvider','acpModel','acpRuntimeKey'];
const routeKey=(provider,model)=>`${provider}\u0000${model}`;

/**
 * ACPX owns external Harness processes and sessions; TaskManager owns the
 * tasks. Runtimes are built on demand from the route a task actually uses, so
 * an unusable configured default route can neither stop the read-only route
 * metadata tools nor block a task that was given a working route. Building a
 * runtime only prepares a launch command: no agent process starts until a task
 * session is ensured.
 */
export class DshBackend {
  constructor(config,onPermission) {
    this.config=config;
    this.onPermission=onPermission;
    this.runtimes=new Map();
    this.sessionStore=createFileSessionStore({stateDir:path.join(config.stateDir,'acpx')});
  }
  /** Cached runtime for one route, launched with that route's own patch. */
  runtimeFor(route) {
    const provider=routeField(route.provider,'provider');
    const model=routeField(route.model,'model');
    const key=routeKey(provider,model);
    const cached=this.runtimes.get(key);
    if(cached)return cached;
    const runtime=createAcpRuntime({
      // Session cwd is supplied by TaskManager for every task. The runtime
      // fallback only needs a valid directory when an external caller omits it;
      // npm mode has no source checkout, so use the plugin process directory.
      cwd:this.config.dshRoot || process.cwd(),
      agentProcessEnv:{ DSH_HOME:this.config.dshHome },
      // Every runtime shares the ACPX session store, so a persistent session
      // stays reachable by its task id regardless of which route owns it.
      sessionStore:this.sessionStore,
      agentRegistry:createAgentRegistry({overrides:{dsh:agentCommand(this.config,{provider,model})}}),
      permissionMode:'approve-reads', nonInteractivePermissions:'deny',
      permissionPolicy:{defaultAction:'escalate'},
      onPermissionRequest:this.onPermission,
      timeoutMs:this.config.startupTimeoutMs, probeAgent:'dsh',
    });
    this.runtimes.set(key,runtime);
    return runtime;
  }
  /**
   * The route a handle belongs to: the handle's own record, else the task that
   * owns it (a handle persisted before per-route runtimes carried no route),
   * else the configured default. The route is never guessed from config when
   * the handle or task can name it.
   */
  routeOf(handle,task) {
    if(typeof handle?.acpProvider==='string'&&typeof handle?.acpModel==='string')
      return {provider:handle.acpProvider,model:handle.acpModel};
    if(typeof task?.provider==='string'&&typeof task?.model==='string')
      return {provider:task.provider,model:task.model};
    return {provider:this.config.provider,model:this.config.model};
  }
  bareHandle(handle) {
    if(!handle||typeof handle!=='object')return handle;
    const bare={...handle};
    for(const key of ROUTE_HANDLE_KEYS)delete bare[key];
    return bare;
  }
  runtimeForHandle(handle,task) {
    return this.runtimeFor(this.routeOf(handle,task));
  }
  async ensure(task) {
    // The task's frozen route, never the configured default: a task fails
    // loudly instead of silently running on another provider. Route metadata and
    // the launch preflight are checked for this route only, so an unusable
    // configured default cannot block a task that was given a working route.
    const route={provider:routeField(task?.provider,'task.provider'),model:routeField(task?.model,'task.model')};
    doctor(this.config,route);
    const runtime=this.runtimeFor(route);
    // ACPX compares launch argv before reusing its record. A new patch path
    // must resume the native session explicitly rather than create new history.
    const persisted=task.handle?.backendSessionId?null:await this.sessionStore.load(task.id);
    const resumeSessionId=task.handle?.backendSessionId||persisted?.acpSessionId;
    const handle=await runtime.ensureSession({agent:'dsh',sessionKey:task.id,mode:'persistent',cwd:task.cwd,
      ...(resumeSessionId?{resumeSessionId}:{})});
    // Every turn pins the exact frozen route; an unavailable route fails here
    // instead of falling back to the launch baseline or the global default.
    const selection=JSON.stringify([route.provider,route.model]);
    try {
      await runtime.setConfigOption({handle,key:'model',value:selection});
      if(task.reasoningEffort)await runtime.setConfigOption({handle,key:'reasoning_effort',value:task.reasoningEffort});
      const status=await runtime.getStatus({handle});
      if(status.models?.currentModelId!==selection)throw new Error(`DSH did not confirm the requested provider/model: expected ${selection}, got ${String(status.models?.currentModelId)}. The task keeps its frozen route and is not switched to another provider.`);
      return {handle:{...handle,acpProvider:route.provider,acpModel:route.model,acpRuntimeKey:routeKey(route.provider,route.model)},route:status.models.currentModelId};
    } catch(error) {
      await runtime.close({handle,reason:'Requested task route could not be confirmed'}).catch(()=>{});
      throw error;
    }
  }
  start(handle,text,requestId,signal) {
    return this.runtimeForHandle(handle).startTurn({handle:this.bareHandle(handle),text,requestId,mode:'prompt',signal,timeoutMs:this.config.turnTimeoutMs});
  }
  close(handle,task) {
    return this.runtimeForHandle(handle,task).close({handle:this.bareHandle(handle),reason:'DSH Commander released the session; persistent history retained'});
  }
}
