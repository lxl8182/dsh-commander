import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveMainWorkspace } from '../src/workspace.mjs';

const WORKSPACE_ENV = ['DSH_COMMANDER_WORKDIR', 'CODEX_WORKSPACE', 'CODEX_WORKDIR', 'CODEX_CWD', 'PWD'];
const originalEnv = new Map(WORKSPACE_ENV.map(name => [name, process.env[name]]));
const originalCwd = process.cwd();

// Own only what this file creates; never touch another suite's directories.
const created = [];
function makeDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

function makeFile() {
  const file = path.join(makeDir('dsh-file-'), 'not-a-dir.txt');
  fs.writeFileSync(file, 'not a directory\n');
  return file;
}

function restoreWorkspaceEnv() {
  for (const name of WORKSPACE_ENV) {
    const value = originalEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// Pin every fallback the resolver may read, so ambient developer environment
// variables can never decide a test outcome.
function setWorkspaceEnv(values = {}) {
  for (const name of WORKSPACE_ENV) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function rootsClient(roots, { capability = true, listChanged = true } = {}) {
  return {
    server: {
      getClientCapabilities: () => (capability ? { roots: { listChanged } } : {}),
      listRoots: async () => ({ roots: roots.map(root => (typeof root === 'string' ? { uri: pathToFileURL(root).href, name: path.basename(root) } : root)) }),
    },
  };
}

function noRootsClient() {
  return { server: { getClientCapabilities: () => ({}), listRoots: async () => { throw new Error('should not be called'); } } };
}

function plainServer() {
  return {};
}

test.after(() => {
  restoreWorkspaceEnv();
  if (process.cwd() !== originalCwd) process.chdir(originalCwd);
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

test('first dispatch without MCP roots succeeds with an explicit cwd', async () => {
  const workspace = makeDir('dsh-first-');
  const plugin = makeDir('dsh-plugin-');
  setWorkspaceEnv();
  assert.equal(await resolveMainWorkspace(noRootsClient(), { requestedCwd: workspace, pluginRoot: plugin }), workspace);
  assert.equal(await resolveMainWorkspace(plainServer(), { requestedCwd: workspace, pluginRoot: plugin }), workspace);
});

test('explicit cwd beats a stale environment variable and the process cwd', async () => {
  const workspace = makeDir('dsh-explicit-');
  const stale = makeDir('dsh-stale-');
  const plugin = makeDir('dsh-plugin-');
  setWorkspaceEnv({ DSH_COMMANDER_WORKDIR: stale });
  assert.equal(await resolveMainWorkspace(noRootsClient(), { requestedCwd: workspace, pluginRoot: plugin }), workspace);
  process.chdir(stale);
  assert.equal(await resolveMainWorkspace(noRootsClient(), { requestedCwd: workspace, pluginRoot: plugin }), workspace);
  process.chdir(originalCwd);
});

test('a requested second root selects that root, not the first', async () => {
  const main = makeDir('dsh-main-');
  const second = makeDir('dsh-second-');
  setWorkspaceEnv();
  const client = rootsClient([main, second]);
  assert.equal(await resolveMainWorkspace(client, { requestedCwd: second }), second);
  assert.equal(await resolveMainWorkspace(client, {}), main);
});

test('rejects a cwd that is missing, relative, a file, empty or non-string', async () => {
  const workspace = makeDir('dsh-valid-');
  const plugin = makeDir('dsh-plugin-');
  setWorkspaceEnv({ DSH_COMMANDER_WORKDIR: workspace });
  const missing = path.join(workspace, 'missing-child');
  const file = makeFile();
  for (const requestedCwd of [missing, 'relative/workspace', file, '', '   ', null, 42]) {
    await assert.rejects(() => resolveMainWorkspace(noRootsClient(), { requestedCwd, pluginRoot: plugin }), /not an existing absolute directory/, `cwd ${JSON.stringify(requestedCwd)} must be rejected`);
  }
});

test('rejects an explicit cwd outside the roots the client exposes', async () => {
  const main = makeDir('dsh-main-');
  const outside = makeDir('dsh-outside-');
  setWorkspaceEnv({ DSH_COMMANDER_WORKDIR: main });
  await assert.rejects(() => resolveMainWorkspace(rootsClient([main]), { requestedCwd: outside }), /not one of them/);
});

test('lists empty or failing listRoots still resolve an explicit cwd', async () => {
  const workspace = makeDir('dsh-resolve-');
  const plugin = makeDir('dsh-plugin-');
  setWorkspaceEnv();
  const emptyList = rootsClient([], { listChanged: true });
  const failingList = {
    server: {
      getClientCapabilities: () => ({ roots: { listChanged: true } }),
      listRoots: async () => { throw new Error('listRoots unavailable'); },
    },
  };
  const noFileRoots = rootsClient([{ uri: 'https://example.test/root', name: 'remote' }]);
  assert.equal(await resolveMainWorkspace(emptyList, { requestedCwd: workspace, pluginRoot: plugin }), workspace);
  assert.equal(await resolveMainWorkspace(failingList, { requestedCwd: workspace, pluginRoot: plugin }), workspace);
  assert.equal(await resolveMainWorkspace(noFileRoots, { requestedCwd: workspace, pluginRoot: plugin }), workspace);
});

test('uses the main MCP root and rejects a different requested directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-root-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-other-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); });
  setWorkspaceEnv();
  const server = rootsClient([root]);
  assert.equal(await resolveMainWorkspace(server, { pluginRoot: other }), fs.realpathSync(root));
  await assert.rejects(() => resolveMainWorkspace(server, { requestedCwd: other, pluginRoot: other }), /not one of them/);
});

test('standalone fallback uses the explicit workspace without choosing plugin root', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  setWorkspaceEnv();
  const server = { server: { getClientCapabilities: () => ({}) } };
  assert.equal(await resolveMainWorkspace(server, { requestedCwd: root, pluginRoot: root }), fs.realpathSync(root));
});
