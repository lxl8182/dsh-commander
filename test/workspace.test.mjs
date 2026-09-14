import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { resolveMainWorkspace } from '../src/workspace.mjs';

test('uses the main MCP root and rejects a different requested directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-root-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-other-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); });
  const server = {
    server: {
      getClientCapabilities: () => ({ roots: { listChanged: true } }),
      listRoots: async () => ({ roots: [{ uri: pathToFileURL(root).href, name: 'main workspace' }] }),
    },
  };
  assert.equal(await resolveMainWorkspace(server, { pluginRoot: other }), fs.realpathSync(root));
  await assert.rejects(() => resolveMainWorkspace(server, { requestedCwd: other, pluginRoot: other }), /current Codex workspace/);
});

test('standalone fallback uses the explicit workspace without choosing plugin root', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fallback-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = { server: { getClientCapabilities: () => ({}) } };
  assert.equal(await resolveMainWorkspace(server, { requestedCwd: root, pluginRoot: root }), fs.realpathSync(root));
});
