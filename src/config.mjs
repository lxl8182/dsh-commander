import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { localWebUrl, ownerCookie } from './web-transport.mjs';

export const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const version = '0.1.0';
const defaultDshPackage = '@deepseek-ai/dsh@latest';
// DSH mounts the standard adapter itself; this is the settings block that owns
// the deepseek-official catalog.
const officialProvider = 'deepseek-official';
const officialSettingsKey = 'llm-deepseek';
const piAiSettingsKey = 'llm-pi-ai';
/** Longest accepted provider/model id; keeps one route token bounded. */
export const routeFieldMax = 160;
/** Upper bound on one dsh_list_routes answer. */
const routeCandidateLimit = 200;
export function loadConfig() {
  const stateDir = path.resolve(process.env.DSH_COMMANDER_HOME || path.join(os.homedir(), '.dsh-commander'));
  const configPath = process.env.DSH_COMMANDER_CONFIG || path.join(stateDir, 'config.json');
  const defaults = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/defaults.json'), 'utf8'));
  const local = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
  const config = { ...defaults, ...local, stateDir, configPath };
  config.dshBackend ??= config.dshWebUrl ? 'web' : 'acp';
  if(!['acp','web'].includes(config.dshBackend))throw new Error('dshBackend must be acp or web');
  if(config.dshBackend==='web'){
    if(!config.dshWebUrl)throw new Error('web backend requires dshWebUrl pointing to the running DSH Web service');
    config.dshWebUrl=localWebUrl(config.dshWebUrl).origin;
  }
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
/** One provider/model id: a non-empty bounded string, trimmed for comparison. */
export function routeField(value, what) {
  if (typeof value !== 'string') throw new Error(`${what} must be a non-empty string`);
  const text = value.trim();
  if (!text) throw new Error(`${what} must be a non-empty string`);
  if (text.length > routeFieldMax) throw new Error(`${what} must be at most ${routeFieldMax} characters`);
  return text;
}
/**
 * Resolve the route one task runs on. A route is atomic: an explicit provider
 * and an explicit model must be supplied together, so a custom provider can
 * never be silently combined with the configured default model. Omitting both
 * keeps the configured default, so existing callers are unchanged.
 */
export function resolveRoute(config, selection = {}) {
  const hasProvider = selection?.provider !== undefined && selection?.provider !== null;
  const hasModel = selection?.model !== undefined && selection?.model !== null;
  if (hasProvider !== hasModel) throw new Error('provider and model must be provided together; omit both to use the configured default route');
  const provider = routeField(hasProvider ? selection.provider : config.provider, 'provider');
  const model = routeField(hasModel ? selection.model : config.model, 'model');
  return { provider, model };
}
/** The route this plugin ships as its default, used only to name a known default. */
function shippedDefaultRoute() {
  try {
    const defaults = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'config/defaults.json'), 'utf8'));
    return { provider: defaults.provider ?? officialProvider, model: defaults.model ?? null };
  } catch {
    return { provider: officialProvider, model: null };
  }
}
/**
 * Read DSH settings for route metadata only. A read or parse failure is reported
 * without the original message: YAML errors quote the offending source line,
 * and settings.yaml may contain credentials.
 */
function readDshSettings(config) {
  const settingsPath = path.join(config.dshHome, 'settings.yaml');
  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); }
  catch { throw new Error(`Cannot read DSH settings at ${settingsPath}: the file is missing or unreadable`); }
  try { return YAML.parse(raw); }
  catch { throw new Error(`DSH settings at ${settingsPath} are not valid YAML; fix that file and retry. Its content is not echoed because it may contain credentials.`); }
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
export function doctor(config, selection = {}) {
  const route = resolveRoute(config, selection);
  const explicit = selection?.provider !== undefined || selection?.model !== undefined;
  const launchMode=normalizeLaunchMode(config.dshLaunchMode,config.dshRoot);
  const dshRoot=launchMode==='npm' ? undefined : optionalAbsolutePath(config.dshRoot);
  const dshPackage=optionalPackageSpec(config.dshPackage || defaultDshPackage);
  const settings=readDshSettings(config);
  // The standard adapter is mounted by DSH itself, not llm-pi-ai settings.
  // Its default catalog is owned by DSH; ACP confirms availability before a turn.
  const official=route.provider===officialProvider;
  const routeSettings=official ? (settings?.[officialSettingsKey] || {}) : settings?.[piAiSettingsKey]?.providers?.[route.provider];
  const model=routeSettings?.models?.find(m=>m.id===route.model);
  const web=config.dshBackend==='web';
  if(web)ownerCookie(config.dshHome,config.dshWebUrl);
  if(!web&&launchMode==='source') {
    if(!dshRoot)throw new Error('Source DSH launch mode requires an absolute dshRoot');
    const bin = path.join(dshRoot,'apps/cli/lib/bin.js');
    if(!fs.existsSync(bin))throw new Error(`DSH built CLI missing: ${bin}. Build the configured DSH checkout first.`);
  }
  if(!model && !(official && routeSettings.models===undefined))throw new Error(`DSH settings do not contain ${route.provider}/${route.model}`);
  return { ok:true, version, provider:route.provider, model:route.model, reasoningEffort:config.reasoningEffort,
    routeSelection:explicit ? 'explicit' : 'configured-default',
    configuredProvider:config.provider, configuredModel:config.model,
    dshBackend:config.dshBackend||'acp',dshWebUrl:config.dshBackend==='web'?config.dshWebUrl:null,
    dshLaunchMode:launchMode, dshRoot:dshRoot || null, dshPackage:launchMode==='npm' ? dshPackage : null,
    dshHome:config.dshHome, stateDir:config.stateDir, credentialReference:routeSettings.apiKeyEnv || (official ? 'DEEPSEEK_API_KEY' : null),
    launchCheck:web ? 'Owner browser-session grant found; tasks connect to the configured running DSH Web service.' : launchMode==='npm' ? `npx resolves ${dshPackage} when the ACP session starts.` : 'Built DSH CLI found in the configured source checkout.',
    modelCatalogCheck:`${model?'Configured catalog entry found':'Built-in DSH catalog'}; ${web?'Web':'ACP'} confirms actual route before each turn.`,
    credentialCheck:'Credentials are resolved by DSH at request time; doctor makes no model request.',
    dshPermissionPreset:settings?.permission?.defaultPreset || 'workspace-write' };
}
/**
 * Read-only route candidates from the current DSH settings, for choosing an
 * optional provider/model pair. Secrets never leave DSH: only provider ids,
 * model ids and where they were found are returned. A candidate is not proof of
 * availability or credentials, and a built-in catalog that settings do not
 * enumerate is reported as unknown instead of being invented.
 */
export function listRoutes(config) {
  const route = resolveRoute(config);
  const settings = readDshSettings(config);
  const candidates = [];
  const seen = new Set();
  const add = (providerId, models, origin) => {
    // A provider key is bounded exactly like a model id: an abnormal key must
    // not widen the answer or make one entry unbounded.
    const provider = typeof providerId === 'string' ? providerId.trim() : '';
    if (!provider || provider.length > routeFieldMax || !Array.isArray(models)) return;
    for (const entry of models) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (!id || id.length > routeFieldMax) continue;
      const key = `${provider}\u0000${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ provider, model: id, origin });
    }
  };
  const officialModels = settings?.[officialSettingsKey]?.models;
  add(officialProvider, officialModels, officialSettingsKey);
  const providers = settings?.[piAiSettingsKey]?.providers;
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const [provider, value] of Object.entries(providers)) add(provider, value?.models, piAiSettingsKey);
  }
  const shipped = shippedDefaultRoute();
  const truncated = candidates.length > routeCandidateLimit;
  return {
    ok: true,
    backend: config.dshBackend || 'acp',
    default: { ...route, reasoningEffort: config.reasoningEffort ?? null },
    candidates: candidates.slice(0, routeCandidateLimit),
    candidateCount: candidates.length,
    truncated,
    defaultIsCandidate: seen.has(`${route.provider}\u0000${route.model}`),
    officialCatalog: Array.isArray(officialModels)
      ? 'Listed from the explicit llm-deepseek models in settings.yaml.'
      : 'DSH owns the built-in deepseek-official catalog; settings do not enumerate it here, so only the shipped default is named.',
    shippedDefault: { provider: shipped.provider, model: shipped.model, source: 'config/defaults.json' },
    availability: 'Candidates come from DSH settings only. DSH confirms the real route, credentials and reachability when a task starts; a listed candidate is not proof it will work.',
    redactions: 'apiKeyEnv, baseURL and every credential value are omitted on purpose.',
  };
}
/**
 * Launch command for one ACP route.
 *
 * A daemon may own several ACP agent processes: DshBackend keeps one cached
 * runtime per task route, and a runtime's agent command is fixed when it is
 * built. The patch therefore carries that route as the launch baseline, and each
 * route gets its own patch file named by a stable hash of the non-secret inputs
 * that shape the file (route, launch mode, checkout or package, Node
 * executable and patch content). All routes use the same naming rule; a later
 * change to the global default cannot change a task's patch path. The backend
 * explicitly resumes the persisted native session when upgrading old argv.
 *
 * A task's own frozen route is still applied per Session by the backend and
 * confirmed before its first prompt. Building a launch command never validates
 * the route against DSH settings: DshBackend.ensure runs doctor(config, route)
 * for the task route before it spawns anything, so releasing an idle task whose
 * provider was removed from settings still works. Patches are written
 * atomically: a concurrent reader must never see a half-written file.
 */
export function agentCommand(config,selection={}) {
  const route=resolveRoute(config,selection);
  const mode=normalizeLaunchMode(config.dshLaunchMode,config.dshRoot);
  const root=mode==='npm' ? undefined : optionalAbsolutePath(config.dshRoot);
  const dshPackage=optionalPackageSpec(config.dshPackage || defaultDshPackage);
  const patch=YAML.stringify([
    {id:'acp',config:{provider:route.provider,model:route.model}},
    {id:'system-prompt',config:{personaSuffix:`Your working directory is {{cwd}}. The verified Node.js executable on this host is ${JSON.stringify(process.execPath)}. If node is absent from the shell PATH, use that absolute executable (PowerShell: & followed by the quoted path). Do not install Node to work around a PATH issue.`}},
    {id:'session-telemetry-otel',disabled:true},
  ]);
  const identity=createHash('sha256').update(JSON.stringify({
    provider:route.provider,model:route.model,mode,root:root??null,dshPackage,node:process.execPath,patch,
  })).digest('hex').slice(0,20);
  const patchPath=path.join(config.stateDir,`acp.${identity}.patch.yml`);
  fs.mkdirSync(config.stateDir,{recursive:true});
  const tmp=`${patchPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp,patch,{mode:0o600});
  fs.renameSync(tmp,patchPath);
  if(mode==='npm') {
    const npx=process.platform==='win32' ? 'npx.cmd' : 'npx';
    return [npx,'--yes',dshPackage,'--profile','acp','--patch',patchPath];
  }
  const pnpm=process.platform==='win32' ? 'pnpm.cmd' : 'pnpm';
  return [pnpm,'--dir',root,'dsh','--profile','acp','--patch',patchPath];
}
