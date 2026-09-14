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

function invalidRequestedCwd(value) {
  return new Error(`dsh_start_task cwd is not an existing absolute directory: ${JSON.stringify(value)}. Pass the current task environment's workspace as an absolute path, or omit cwd to use the MCP roots the client exposes.`);
}

/**
 * `undefined` means the caller did not supply cwd, so every fallback stays
 * available. Any other value was supplied explicitly and therefore must be a
 * usable directory: a typo, a relative path or a guess must fail loudly instead
 * of silently resolving to some other workspace.
 */
function explicitDirectoryOrThrow(value) {
  if (value === undefined) return undefined;
  const supplied = typeof value === 'string' ? value.trim() : '';
  const resolved = supplied ? existingDirectory(supplied) : null;
  if (!resolved) throw invalidRequestedCwd(value);
  return resolved;
}

/**
 * Resolve the workspace for a dispatched task. An explicitly supplied cwd is
 * validated first and is never silently replaced. Codex clients that support
 * MCP roots are authoritative and may contain several roots, so a supplied cwd
 * selects the root it matches; clients without roots (no capability, no roots
 * returned, or a failing listRoots) fall back to the explicit cwd before the
 * environment and the process cwd, and never choose the plugin installation
 * directory just because it happens to be the process cwd.
 */
export async function resolveMainWorkspace(server, { requestedCwd, pluginRoot } = {}) {
  const requested = explicitDirectoryOrThrow(requestedCwd);

  const capabilities = server?.server?.getClientCapabilities?.() ?? {};
  if (capabilities.roots) {
    let listed;
    try { listed = await server.server.listRoots({}, { timeout: 5000 }); } catch { listed = undefined; }
    const roots = (listed?.roots ?? []).map(root => fileRoot(root.uri)).filter(Boolean);
    if (roots.length > 0) {
      if (!requested) return roots[0];
      const matched = roots.find(root => samePath(root, requested));
      if (!matched) {
        throw new Error(`dsh_start_task must use a workspace exposed by the current Codex session (${roots.join(', ')}); the supplied cwd ${requested} is not one of them`);
      }
      return matched;
    }
  }

  if (requested) return requested;

  for (const name of ['DSH_COMMANDER_WORKDIR', 'CODEX_WORKSPACE', 'CODEX_WORKDIR', 'CODEX_CWD', 'PWD']) {
    const candidate = existingDirectory(process.env[name]);
    if (candidate) return candidate;
  }

  const launchedFrom = existingDirectory(process.cwd());
  if (launchedFrom && (!pluginRoot || !samePath(launchedFrom, pluginRoot))) return launchedFrom;

  throw new Error('Cannot determine the main Codex workspace. The MCP client exposed no file root; set DSH_COMMANDER_WORKDIR or pass an absolute cwd.');
}
