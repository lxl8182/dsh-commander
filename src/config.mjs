import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const version = '0.1.0';
export function loadConfig() {
  const stateDir = path.resolve(process.env.DSH_COMMANDER_HOME || path.join(os.homedir(), '.dsh-commander'));
  const configPath = process.env.DSH_COMMANDER_CONFIG || path.join(stateDir, 'config.json');
  const defaults = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/defaults.json'), 'utf8'));
  const local = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const config = { ...defaults, ...local, stateDir, configPath };
  config.dshHome = path.resolve(config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  config.dshRoot = path.resolve(config.dshRoot);
  for (const [key,min,max] of [['maxConcurrent',1,16],['turnTimeoutMs',1000,86400000],['startupTimeoutMs',1000,300000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  return config;
}
export function pipePath(config) {
  const hash = createHash('sha256').update(config.stateDir).digest('hex').slice(0,20);
  return process.platform === 'win32' ? `\\\\.\\pipe\\dsh-commander-${hash}` : path.join(config.stateDir, 'control.sock');
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive:true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value,null,2)+'\n', { mode:0o600 });
  fs.renameSync(tmp,file);
}
/** Read only route metadata; credentials remain inside the DSH credential service. */
export function doctor(config) {
  const bin = path.join(config.dshRoot,'apps/cli/lib/bin.js');
  const settingsPath=path.join(config.dshHome,'settings.yaml');
  const settings=YAML.parse(fs.readFileSync(settingsPath,'utf8'));
  // The standard adapter is mounted by DSH itself, not llm-pi-ai settings.
  // Its default catalog is owned by DSH; ACP confirms availability before a turn.
  const official=config.provider==='deepseek-official';
  const route=official ? (settings?.['llm-deepseek'] || {}) : settings?.['llm-pi-ai']?.providers?.[config.provider];
  const model=route?.models?.find(m=>m.id===config.model);
  if(!fs.existsSync(bin))throw new Error(`DSH built CLI missing: ${bin}. Build the configured DSH checkout first.`);
  if(!model && !(official && route.models===undefined))throw new Error(`DSH settings do not contain ${config.provider}/${config.model}`);
  return { ok:true, version, provider:config.provider, model:config.model, reasoningEffort:config.reasoningEffort,
    dshRoot:config.dshRoot, dshHome:config.dshHome, stateDir:config.stateDir, credentialReference:route.apiKeyEnv || (official ? 'DEEPSEEK_API_KEY' : null),
    modelCatalogCheck:model ? 'Configured catalog entry found; ACP confirms actual route before each turn.' : 'Built-in DSH catalog; ACP confirms actual route before each turn.',
    credentialCheck:'Credentials are resolved by DSH at request time; doctor makes no model request.',
    dshPermissionPreset:settings?.permission?.defaultPreset || 'workspace-write' };
}
export function agentCommand(config) {
  doctor(config);
  const patchPath=path.join(config.stateDir,'acp.patch.yml');
  fs.mkdirSync(config.stateDir,{recursive:true});
  fs.writeFileSync(patchPath,YAML.stringify([
    {id:'acp',config:{provider:config.provider,model:config.model}},
    {id:'system-prompt',config:{personaSuffix:`Your working directory is {{cwd}}. The verified Node.js executable on this host is ${JSON.stringify(process.execPath)}. If node is absent from the shell PATH, use that absolute executable (PowerShell: & followed by the quoted path). Do not install Node to work around a PATH issue.`}},
    {id:'session-telemetry-otel',disabled:true},
  ]));
  return [process.execPath,path.join(config.dshRoot,'apps/cli/lib/bin.js'),'--profile','acp','--patch',patchPath];
}
