import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function existingDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  try {
    const resolved = fs.realpathSync(value);
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function samePath(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function fileRoot(uri) {
  try {
    const url = new URL(uri);
    return url.protocol === 'file:' ? existingDirectory(fileURLToPath(url)) : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the workspace exposed by the main Codex MCP session. Codex clients
 * that support MCP roots are authoritative; explicit/env fallbacks keep the
 * standalone CLI and older MCP clients usable without silently choosing the
 * plugin installation directory.
 */
export async function resolveMainWorkspace(server, { requestedCwd, pluginRoot } = {}) {
  const capabilities = server?.server?.getClientCapabilities?.() ?? {};
  if (capabilities.roots) {
    let listed;
    try { listed = await server.server.listRoots({}, { timeout: 5000 }); } catch { listed = undefined; }
    const roots = (listed?.roots ?? []).map(root => fileRoot(root.uri)).filter(Boolean);
    if (roots.length > 0) {
      const requested = existingDirectory(requestedCwd);
      if (requested && !roots.some(root => samePath(root, requested))) {
        throw new Error(`dsh_start_task must use the current Codex workspace (${roots[0]}); supplied cwd is outside it`);
      }
      return roots[0];
    }
  }

  for (const name of ['DSH_COMMANDER_WORKDIR', 'CODEX_WORKSPACE', 'CODEX_WORKDIR', 'CODEX_CWD', 'PWD']) {
    const candidate = existingDirectory(process.env[name]);
    if (candidate) return candidate;
  }

  const requested = existingDirectory(requestedCwd);
  if (requested) return requested;

  const launchedFrom = existingDirectory(process.cwd());
  if (launchedFrom && (!pluginRoot || !samePath(launchedFrom, pluginRoot))) return launchedFrom;

  throw new Error('Cannot determine the main Codex workspace. The MCP client exposed no file root; set DSH_COMMANDER_WORKDIR or pass an absolute cwd.');
}
