import path from 'node:path';
import { createAcpRuntime, createAgentRegistry, createFileSessionStore } from 'acpx/runtime';
import { agentCommand } from './config.mjs';

/** ACPX owns the complete external Harness process and the durable ACP session. */
export class DshBackend {
  constructor(config,onPermission) {
    this.config=config;
    this.runtime=createAcpRuntime({
      cwd:config.dshRoot,
      agentProcessEnv:{ DSH_HOME:config.dshHome },
      sessionStore:createFileSessionStore({stateDir:path.join(config.stateDir,'acpx')}),
      agentRegistry:createAgentRegistry({overrides:{dsh:agentCommand(config)}}),
      permissionMode:'approve-reads', nonInteractivePermissions:'deny',
      permissionPolicy:{defaultAction:'escalate'},
      onPermissionRequest:onPermission,
      timeoutMs:config.startupTimeoutMs, probeAgent:'dsh',
    });
  }
  async ensure(task) {
    const handle=await this.runtime.ensureSession({agent:'dsh',sessionKey:task.id,mode:'persistent',cwd:task.cwd});
    // Every turn pins the exact route; unavailable routes fail rather than fall back.
    const selection=JSON.stringify([task.provider,task.model]);
    await this.runtime.setConfigOption({handle,key:'model',value:selection});
    if(task.reasoningEffort)await this.runtime.setConfigOption({handle,key:'reasoning_effort',value:task.reasoningEffort});
    const status=await this.runtime.getStatus({handle});
    if(status.models?.currentModelId!==selection)throw new Error('DSH did not confirm the requested provider/model');
    return {handle,route:status.models.currentModelId};
  }
  start(handle,text,requestId,signal) {
    return this.runtime.startTurn({handle,text,requestId,mode:'prompt',signal,timeoutMs:this.config.turnTimeoutMs});
  }
  close(handle) { return this.runtime.close({handle,reason:'DSH Commander released the session; persistent history retained'}); }
}
