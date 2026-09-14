import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const version = '0.1.0';
const defaultDshPackage = '@deepseek-ai/dsh@latest';
export function loadConfig() {
  const stateDir = path.resolve(process.env.DSH_COMMANDER_HOME || path.join(os.homedir(), '.dsh-commander'));
  const configPath = process.env.DSH_COMMANDER_CONFIG || path.join(stateDir, 'config.json');
  const defaults = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/defaults.json'), 'utf8'));
  const local = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const config = { ...defaults, ...local, stateDir, configPath };
  config.dshHome = path.resolve(config.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  config.dshLaunchMode = normalizeLaunchMode(config.dshLaunchMode, config.dshRoot);
  config.dshRoot = optionalAbsolutePath(config.dshRoot);
  if (config.dshLaunchMode === 'npm') config.dshRoot = undefined;
  config.dshPackage = optionalPackageSpec(config.dshPackage || defaultDshPackage);
  if (config.dshLaunchMode === 'source' && !config.dshRoot) {
    throw new Error('Source DSH launch mode requires an absolute dshRoot');
  }
  for (const [key,min,max] of [['maxConcurrent',1,16],['turnTimeoutMs',1000,86400000],['startupTimeoutMs',1000,300000]]) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}`);
  }
  return config;
}
function normalizeLaunchMode(value, dshRoot) {
  const mode = value || (dshRoot ? 'source' : 'npm');
  if (mode !== 'source' && mode !== 'npm') throw new Error(`Invalid dshLaunchMode: ${mode}`);
  return mode;
}
function optionalAbsolutePath(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('dshRoot must be an absolute path');
  return path.resolve(value);
}
function optionalPackageSpec(value) {
  if (typeof value !== 'string' || !value.trim() || /\s/u.test(value)) throw new Error('dshPackage must be a package spec without whitespace');
  return value.trim();
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
  const launchMode=normalizeLaunchMode(config.dshLaunchMode,config.dshRoot);
  const dshRoot=launchMode==='npm' ? undefined : optionalAbsolutePath(config.dshRoot);
  const dshPackage=optionalPackageSpec(config.dshPackage || defaultDshPackage);
  const settingsPath=path.join(config.dshHome,'settings.yaml');
  const settings=YAML.parse(fs.readFileSync(settingsPath,'utf8'));
  // The standard adapter is mounted by DSH itself, not llm-pi-ai settings.
  // Its default catalog is owned by DSH; ACP confirms availability before a turn.
  const official=config.provider==='deepseek-official';
  const route=official ? (settings?.['llm-deepseek'] || {}) : settings?.['llm-pi-ai']?.providers?.[config.provider];
  const model=route?.models?.find(m=>m.id===config.model);
  if(launchMode==='source') {
    if(!dshRoot)throw new Error('Source DSH launch mode requires an absolute dshRoot');
    const bin = path.join(dshRoot,'apps/cli/lib/bin.js');
    if(!fs.existsSync(bin))throw new Error(`DSH built CLI missing: ${bin}. Build the configured DSH checkout first.`);
  }
  if(!model && !(official && route.models===undefined))throw new Error(`DSH settings do not contain ${config.provider}/${config.model}`);
  return { ok:true, version, provider:config.provider, model:config.model, reasoningEffort:config.reasoningEffort,
    dshLaunchMode:launchMode, dshRoot:dshRoot || null, dshPackage:launchMode==='npm' ? dshPackage : null,
    dshHome:config.dshHome, stateDir:config.stateDir, credentialReference:route.apiKeyEnv || (official ? 'DEEPSEEK_API_KEY' : null),
    launchCheck:launchMode==='npm' ? `npx resolves ${dshPackage} when the ACP session starts.` : 'Built DSH CLI found in the configured source checkout.',
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
  const mode=normalizeLaunchMode(config.dshLaunchMode,config.dshRoot);
  if(mode==='npm') {
    const npx=process.platform==='win32' ? 'npx.cmd' : 'npx';
    return [npx,'--yes',optionalPackageSpec(config.dshPackage || defaultDshPackage),'--profile','acp','--patch',patchPath];
  }
  const root=optionalAbsolutePath(config.dshRoot);
  const pnpm=process.platform==='win32' ? 'pnpm.cmd' : 'pnpm';
  return [pnpm,'--dir',root,'dsh','--profile','acp','--patch',patchPath];
}
