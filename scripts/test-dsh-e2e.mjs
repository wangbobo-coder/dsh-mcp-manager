/**
 * End-to-end test of the DSH write path, on a copy of the real profile.
 *
 * Covers the case the patch layer exists for: a server DSH does not have yet
 * has no live row to edit, so it must land in the patch layer, read back as a
 * pending server, and disappear again on removal.
 *
 *   node scripts/test-dsh-e2e.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyServerToTarget, removeServer } from '../lib/ops.js';
import { readDshPatchServers, writeDshPatchServer } from '../lib/dsh-patch.js';
import { scanAll } from '../lib/scan.js';

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}\n       ${error.message}`);
    process.exitCode = 1;
  }
}

const root = mkdtempSync(join(tmpdir(), 'mcpm-e2e-'));
const profileDir = join(root, 'profile');
mkdirSync(profileDir, { recursive: true });
const REAL = join(process.env.DSH_PROFILE_DIR?.trim() || join(process.env.DSH_HOME?.trim() || '', 'profiles', 'desktop'), 'cordis.patch.yml');
/*
 * Strip any mounted MCP rows out of the fixture.
 *
 * The user's live profile legitimately contains whatever they have mounted, and
 * copying it verbatim made this suite fail for the wrong reason: the scan then
 * reported their servers alongside the one this test adds (expected 1, saw 5).
 * Slicing the RAW text rather than re-serialising keeps their blank-line spacing
 * intact, so the byte-identical assertions below still mean something.
 */
function stripMcpRows(text) {
  let out = text;
  for (;;) {
    const at = out.lastIndexOf('- insert:');
    if (at < 0) break;
    if (!/@deepseek-ai\/dsh-mcp-client/.test(out.slice(at))) break;
    out = out.slice(0, at);
  }
  return `${out.replace(/\s+$/, '')}\n`;
}
if (existsSync(REAL)) writeFileSync(join(profileDir, 'cordis.patch.yml'), stripMcpRows(readFileSync(REAL, 'utf8')), 'utf8');
else writeFileSync(join(profileDir, 'cordis.patch.yml'), '# empty profile\n', 'utf8');

const backups = [];
const store = {
  backup(path, text) { backups.push({ path, text }); },
  recordOwnership() {},
  forgetOwnership() {},
  ownershipOf() { return undefined; },
  readFile(path) {
    /* Mirror the real store: absence is a value, not a throw. */
    try {
      const text = readFileSync(path, 'utf8');
      return { ok: true, exists: true, text, hash: 'h', mtimeMs: 0 };
    } catch (error) {
      if (error && error.code === 'ENOENT') return { ok: true, exists: false, text: '', hash: null, mtimeMs: 0 };
      return { ok: false, exists: false, text: '', hash: null, error: String(error.message ?? error) };
    }
  },
  mutate() { throw new Error('DSH must not go through the file path'); },
};
/* configEditor absent => no live rows, which is the "brand new server" case. */
const deps = { store, configEditor: undefined, profileDir };

const SERVER = {
  name: 'zz-e2e-probe',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'zz-e2e-probe-mcp'],
  env: { ZZ_TOKEN: 'secret-value' },
};

console.log('DSH end-to-end, patch layer');

const applied = await applyServerToTarget(deps, { clientId: 'dsh', scope: 'profile', server: SERVER });
check('a new DSH server is accepted through the patch layer', () => {
  assert.equal(applied.ok, true, applied.error ?? applied.code);
  assert.equal(applied.via, 'patch');
  assert.equal(applied.restartRequired, true, 'a patch write is not live until reconcile');
});

check('the server is now visible as pending on disk', () => {
  const pending = readDshPatchServers(profileDir).find((server) => server.name === 'zz-e2e-probe');
  assert.ok(pending, 'must read back');
  assert.equal(pending.command, 'npx');
  assert.equal(pending.env.ZZ_TOKEN, 'secret-value');
});

check('scan reports it under DSH without a live configEditor', () => {
  const snapshot = scanAll({ store, configEditor: undefined, projectRoots: [], reveal: false, profileDir });
  const node = snapshot.servers.find((server) => server.name === 'zz-e2e-probe');
  assert.ok(node, 'the pending server must appear in the matrix');
  assert.equal(node.clients.includes('dsh'), true);
  const dsh = snapshot.clients.find((client) => client.id === 'dsh');
  assert.equal(dsh.pendingCount, 1);
});

check('a credential in a pending server is masked in the scan payload', () => {
  const snapshot = scanAll({ store, configEditor: undefined, projectRoots: [], reveal: false, profileDir });
  const text = JSON.stringify(snapshot);
  assert.equal(text.includes('secret-value'), false, 'the literal must not reach the payload');
});

check('re-applying is idempotent', () => {
  const before = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
  const again = writeDshPatchServer({ server: SERVER, store, profileDir });
  assert.equal(again.changed, false, 'a repeat apply must not add a second row');
  assert.equal(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8'), before);
});

const removed = await removeServer(deps, { clientId: 'dsh', scope: 'profile', name: 'zz-e2e-probe' });
const secondRemove = await removeServer(deps, { clientId: 'dsh', scope: 'profile', name: 'zz-e2e-probe' });
check('removal takes the pending row back out', () => {
  assert.equal(removed.ok, true, removed.error ?? removed.code);
  assert.equal(readDshPatchServers(profileDir).some((server) => server.name === 'zz-e2e-probe'), false);
});

check('removing it a second time reports missing instead of succeeding', () => {
  assert.ok(secondRemove, 'second removal result missing');
  assert.equal(secondRemove.ok, false);
  assert.equal(secondRemove.code, 'error.dsh.missing');
});

check('every write was backed up first', () => {
  assert.ok(backups.length >= 2, `expected a backup per write, got ${backups.length}`);
  assert.ok(backups.every((entry) => typeof entry.text === 'string'));
});

/*
 * The case that used to be broken: the row has ALREADY been reconciled into a
 * live entry (normal in a running Harness). Removal must not try to blank that
 * row's config — `configEditor` cannot delete a row and mcp-client requires
 * `serverName`, so the edit was rejected and the row survived the request.
 * The patch item is the part this plugin owns, and removing it is the removal.
 */
console.log('removal with a live row');
function fakeEditor(rows) {
  const state = { rows: [...rows], edits: 0 };
  return {
    state,
    configuration() { return state.rows; },
    async edit() {
      state.edits += 1;
      throw new Error('a live row must not be edited to remove it');
    },
  };
}

const liveName = 'zz-live-probe';
writeDshPatchServer({
  server: { name: liveName, transport: 'stdio', command: 'npx', args: ['-y', 'live-probe-mcp'], env: {} },
  store,
  profileDir,
});
const editor = fakeEditor([{
  entry: { id: `include:mcp-${liveName}`, name: '@deepseek-ai/dsh-mcp-client' },
  inherited: {},
  override: { serverName: liveName, transport: 'stdio', command: 'npx', args: ['-y', 'live-probe-mcp'] },
}]);
const liveRemoved = await removeServer(
  { store, configEditor: editor, profileDir, removeWaitMs: 300 },
  { clientId: 'dsh', scope: 'profile', name: liveName },
);

check('a live row is removed through its patch item, not by editing its config', () => {
  assert.equal(liveRemoved.ok, true, liveRemoved.error ?? liveRemoved.code);
  assert.equal(liveRemoved.via, 'patch');
  assert.equal(readDshPatchServers(profileDir).some((server) => server.name === liveName), false, 'the patch item is gone');
  assert.equal(editor.state.edits, 0, 'configEditor.edit must not be called');
});

check('a still-reconciling removal reports activating, not a live lie', () => {
  assert.equal(liveRemoved.live, false, 'the fake row cannot disappear, so live must be false');
  assert.equal(liveRemoved.activating, true);
  assert.equal(liveRemoved.restartRequired, false);
});

check('a live row this plugin never wrote is refused, and left alone', async () => {
  const otherEditor = fakeEditor([{
    entry: { id: 'include:mcp-not-ours', name: '@deepseek-ai/dsh-mcp-client' },
    inherited: {},
    override: { serverName: 'not-ours', transport: 'stdio', command: 'npx' },
  }]);
  const result = await removeServer(
    { store, configEditor: otherEditor, profileDir, removeWaitMs: 100 },
    { clientId: 'dsh', scope: 'profile', name: 'not-ours' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.dsh.notPatchRow');
  assert.equal(otherEditor.state.edits, 0);
});

console.log(`\n${pass} passing`);
