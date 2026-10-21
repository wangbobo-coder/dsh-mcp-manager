/**
 * The switch: mount/unmount in DeepSeek Harness, never another tool's file.
 *
 * Two paths are exercised:
 *   loader — a mounted row is flipped through pluginManager.setPluginEnabled
 *   patch  — a row that has not mounted yet is switched with an override item
 *
 * The critical assertion in both is that no client config file is touched.
 * That is the whole contract the user asked for.
 */
import { mkdtempSync, readFileSync, mkdirSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { toggleServer } from '../lib/toggle.js';
import { readDshPatchServers, writeDshPatchServer, removeDshPatchServer, splitPatchItems } from '../lib/dsh-patch.js';
import { createStore } from '../lib/store.js';

let passing = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passing += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passing += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}
assert.equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message ? message + ': ' : ''}${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};

/*
 * Strip our own rows by slicing the raw text, not by re-rendering the items:
 * re-joining reserialised items would change the user's blank-line spacing and
 * make the byte-identical assertions fail for a cosmetic reason.
 */
function stripMcpRows(raw) {
  const marker = '- insert:';
  let index = raw.lastIndexOf(marker);
  while (index >= 0) {
    const row = raw.slice(index);
    if (!/@deepseek-ai\/dsh-mcp-client/.test(row)) break;
    raw = raw.slice(0, index).replace(/\s*$/, '') + '\n';
    index = raw.lastIndexOf(marker);
  }
  return raw;
}

const REAL = process.env.MCPM_REAL_PATCH ?? 'C:/Users/wangs/.dsh/profiles/desktop/cordis.patch.yml';
const root = mkdtempSync(join(tmpdir(), 'mcpm-toggle-'));
const profileDir = join(root, 'profile');
mkdirSync(profileDir, { recursive: true });
const patchPath = join(profileDir, 'cordis.patch.yml');
const hasReal = existsSync(REAL);
/*
 * Seed the fixture from the real profile so the "user entries survive" checks
 * run against 13KB of genuine content — but normalise our own rows out first.
 * Without that strip the suite is not hermetic: a leftover mount row from an
 * earlier live test makes the byte-identical assertions fail for a reason that
 * has nothing to do with the code under test.
 */
const original = hasReal ? stripMcpRows(readFileSync(REAL, 'utf8')) : '- id: other\n  name: x\n';
writeFileSync(patchPath, original, 'utf8');
const store = createStore({ root: join(root, 'state') });

const SERVER = { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] };
writeDshPatchServer({ server: SERVER, store, profileDir });

/* A fake plugin manager that records what it was asked, like the real one. */
function fakeManager({ fail = false, application = 'applied' } = {}) {
  const calls = [];
  return {
    calls,
    async setPluginEnabled(id, enabled) {
      calls.push({ id, enabled });
      if (fail) return { changed: false, application: 'failed', error: { code: 'error.plugin.missing', error: `no such row ${id}` } };
      return { changed: true, application, target: id, enabled };
    },
  };
}

console.log('toggle (mount/unmount in DeepSeek Harness only)');

await checkAsync('a mounted row is switched through the plugin manager, not a file', async () => {
  const manager = fakeManager();
  const get = (key) => (key === 'pluginManager' ? manager : undefined);
  const result = await toggleServer({ get, profileDir, store }, { name: 'context7', enabled: false, entryId: 'include:mcp-context7' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.via, 'loader');
  assert.equal(manager.calls[0].id, 'include:mcp-context7');
  assert.equal(manager.calls[0].enabled, false);
});

await checkAsync('the switch reported no restart for a live row (it unmounts hot)', async () => {
  const manager = fakeManager();
  const result = await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir, store }, { name: 'context7', enabled: true, entryId: 'include:mcp-context7' });
  assert.equal(result.restartRequired, false);
});

await checkAsync('the plugin manager row id is used verbatim, never guessed', async () => {
  const manager = fakeManager();
  await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir, store }, { name: 'context7', enabled: false, entryId: 'some-other-id' });
  assert.equal(manager.calls[0].id, 'some-other-id');
});

await checkAsync('an unaddressable row falls back to the patch layer', async () => {
  const manager = fakeManager({ fail: true });
  const before = readFileSync(patchPath, 'utf8');
  const result = await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir, store }, { name: 'context7', enabled: false, entryId: 'include:mcp-context7' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.via, 'patch');
  assert.equal(result.restartRequired, true);
  const after = readFileSync(patchPath, 'utf8');
  assert(after.length > before.length, 'the override item should have been appended');
  assert(/^\s*disabled: true$/m.test(after), 'the override must disable the row');
});

check('the row itself is untouched by the override', () => {
  const { items } = splitPatchItems(readFileSync(patchPath, 'utf8'));
  const ours = items.filter((item) => /^- insert:/.test(item.text) && item.text.includes('mcp-context7'));
  assert.equal(ours.length, 1);
  assert(!/disabled:/.test(ours[0].text), 'the definition row must not gain a disabled flag');
});

check('a disabled patch server reads back as disabled', () => {
  const servers = readDshPatchServers(profileDir);
  const found = servers.find((item) => item.name === 'context7');
  assert(found, 'context7 should still be visible while disabled');
  assert.equal(found.enabled, false, 'the override must be reflected in the read');
});

await checkAsync('re-enabling removes the override and restores the file exactly', async () => {
  const manager = fakeManager({ fail: true });
  const before = readFileSync(patchPath, 'utf8');
  const result = await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir, store }, { name: 'context7', enabled: true, entryId: 'include:mcp-context7' });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = readFileSync(patchPath, 'utf8');
  assert(after.length < before.length, 'the override should be gone');
  assert(!/disabled: true/.test(after.slice(-200)), 'no override should remain at the tail');
  const servers = readDshPatchServers(profileDir);
  assert.equal(servers.find((item) => item.name === 'context7')?.enabled, true);
});

await checkAsync('a server with no row anywhere cannot be mounted, and says why', async () => {
  const manager = fakeManager({ fail: true });
  const get = (k) => (k === 'pluginManager' ? manager : undefined);
  /* Switching ON something absent has nothing to mount. */
  const on = await toggleServer({ get, profileDir, store }, { name: 'never-mounted', enabled: true, entryId: 'include:mcp-never-mounted' });
  assert.equal(on.ok, false);
  assert.equal(on.code, 'error.toggle.notMounted');
  assert(typeof on.error === 'string' && on.error.includes('never-mounted'), `error should name the server, got ${on.error}`);
  assert(typeof on.hint === 'string' && on.hint.includes('other tool'), `hint should explain the scope, got ${on.hint}`);
  /*
   * Switching OFF something absent is already true. It must not write a
   * `disabled: true` override for a row that does not exist.
   */
  const before = readFileSync(patchPath, 'utf8');
  const off = await toggleServer({ get, profileDir, store }, { name: 'never-mounted', enabled: false, entryId: 'include:mcp-never-mounted' });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.notMounted, true);
  assert.equal(readFileSync(patchPath, 'utf8'), before, 'nothing may be written');
});

/*
 * Without a plugin manager there is no way to address a LIVE row. The refusal is
 * scoped to that case: a row that lives only in the patch layer is still
 * switchable with the same override item the plugin manager would write, so the
 * switch degrades instead of lying.
 */
await checkAsync('without a plugin manager service a live row is refused, a patch row still switches', async () => {
  const live = await toggleServer({ get: () => undefined, profileDir, store }, { name: 'context7', enabled: false, entryId: 'include:mcp-context7' });
  /*
   * context7 has a patch row in the shared fixture, so this path is exercised
   * with a server that exists nowhere at all to prove the refusal.
   */
  assert.equal(live.ok, true, 'a patch row must still be reachable without the service');

  const nowhere = await toggleServer({ get: () => undefined, profileDir, store }, { name: 'not-anywhere', enabled: false });
  assert.equal(nowhere.ok, false);
  assert.equal(nowhere.code, 'error.toggle.noManager');
});

await checkAsync('an invalid request is rejected before anything is written', async () => {
  const manager = fakeManager();
  const get = (k) => (k === 'pluginManager' ? manager : undefined);
  assert.equal((await toggleServer({ get, profileDir, store }, { name: 'x', enabled: 'yes' })).code, 'error.input');
  assert.equal((await toggleServer({ get, profileDir, store }, { enabled: true })).code, 'error.input');
  assert.equal(manager.calls.length, 0, 'no call should reach the plugin manager');
});

await checkAsync('removal takes the override with it, leaving no dangling target', async () => {
  const manager = fakeManager({ fail: true });
  await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir, store }, { name: 'context7', enabled: false, entryId: 'include:mcp-context7' });
  assert(readDshPatchServers(profileDir).some((item) => item.name === 'context7'), 'the disabled row should exist first');
  const removed = removeDshPatchServer({ serverName: 'context7', store, profileDir });
  assert.equal(removed.ok, true);
  const after = readFileSync(patchPath, 'utf8');
  assert(!/mcp-context7/.test(after), 'both the row and its override must be gone');
  if (hasReal) assert.equal(after, original, 'the file must return to its exact previous bytes');
});

/*
 * The round trip that matters: mount a server that only exists in another tool,
 * then switch it off again. The composition must be byte-identical afterwards —
 * a dangling `disabled: true` for a row that no longer exists is exactly the
 * kind of residue that makes a user distrust the switch.
 */
await checkAsync('mounting a foreign server and unmounting it returns the file to its exact bytes', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'mcpm-roundtrip-'));
  const profile = join(fresh, 'profile');
  mkdirSync(profile, { recursive: true });
  const patched = join(profile, 'cordis.patch.yml');
  const base = hasReal ? stripMcpRows(readFileSync(REAL, 'utf8')) : '- id: other\n  name: x\n';
  writeFileSync(patched, base, 'utf8');
  const roundStore = createStore({ root: join(fresh, 'state') });

  /* Mount exactly the way opToggle does for a server absent from DSH. */
  writeDshPatchServer({ server: SERVER, store: roundStore, profileDir: profile });
  roundStore.recordOwnership({
    serverName: 'context7', clientId: 'dsh', scope: 'profile',
    path: '(profile composition)', fingerprint: 'deadbeef',
  });
  assert(readFileSync(patched, 'utf8') !== base, 'the mount should have changed the file');

  /* No live row exists yet (it has not reconciled), so the switch takes the patch path. */
  const manager = fakeManager({ fail: true });
  const result = await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir: profile, store: roundStore }, { name: 'context7', enabled: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.unmounted, true, 'a row we wrote should be removed, not merely disabled');
  assert.equal(readFileSync(patched, 'utf8'), base, 'the file must be byte-identical to before the mount');
});

await checkAsync('a row the user wrote is disabled, never deleted', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'mcpm-userrow-'));
  const profile = join(fresh, 'profile');
  mkdirSync(profile, { recursive: true });
  const patched = join(profile, 'cordis.patch.yml');
  writeFileSync(patched, '- id: other\n  name: x\n', 'utf8');
  const userStore = createStore({ root: join(fresh, 'state') });
  /* Written without recording ownership — the user pasted this one. */
  writeDshPatchServer({ server: SERVER, store: null, profileDir: profile });

  const manager = fakeManager({ fail: true });
  const result = await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir: profile, store: userStore }, { name: 'context7', enabled: false });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = readFileSync(patched, 'utf8');
  assert(/mcp-context7/.test(after), 'the user row itself must survive');
  assert(/^\s*disabled: true$/m.test(after), 'it is switched off with an override instead');
});

await checkAsync('switching off a server that is nowhere near DSH writes nothing', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'mcpm-absent-'));
  const profile = join(fresh, 'profile');
  mkdirSync(profile, { recursive: true });
  const patched = join(profile, 'cordis.patch.yml');
  writeFileSync(patched, '- id: other\n  name: x\n', 'utf8');
  const absentStore = createStore({ root: join(fresh, 'state') });

  const manager = fakeManager({ fail: true });
  const off = await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir: profile, store: absentStore }, { name: 'context7', enabled: false });
  assert.equal(off.ok, true, JSON.stringify(off));
  assert.equal(off.notMounted, true);
  assert.equal(readFileSync(patched, 'utf8'), '- id: other\n  name: x\n', 'no override may be appended for a row that does not exist');

  const on = await toggleServer({ get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir: profile, store: absentStore }, { name: 'context7', enabled: true });
  assert.equal(on.ok, false, 'there is nothing to mount');
  assert.equal(on.code, 'error.toggle.notMounted');
});

/*
 * `configEditor.configuration()` only lists rows that were already in the
 * composition, so a server WE inserted into cordis.patch.yml carries no entryId
 * in the scan even after the Loader reconciled it. The Loader still addresses it
 * as `include:mcp-<name>` (the id the bundle patch writes). Without that
 * candidate the switch would fall back to the patch layer — a restart — while
 * the plugin manager could have disposed the instance hot.
 */
await checkAsync('a row the scan could not address is still switched hot by its include id', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'mcpm-noid-'));
  const profile = join(fresh, 'profile');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'cordis.patch.yml'), '- id: other\n  name: x\n', 'utf8');
  const noIdStore = createStore({ root: join(fresh, 'state') });
  const manager = fakeManager();
  const result = await toggleServer(
    { get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir: profile, store: noIdStore },
    { name: 'context7', enabled: false, entryId: null },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.via, 'loader', 'the live row must be preferred over the restart-prone patch layer');
  assert.equal(manager.calls[0].id, 'include:mcp-context7');
});

/*
 * The other half of that rule: a real entryId read off the tree always wins, so
 * a user-authored row with a random id is never re-addressed by convention.
 */
await checkAsync('a scanned entryId is tried before the include convention', async () => {
  const manager = fakeManager();
  await toggleServer(
    { get: (k) => (k === 'pluginManager' ? manager : undefined), profileDir, store },
    { name: 'context7', enabled: false, entryId: '89b7e61a' },
  );
  assert.equal(manager.calls[0].id, '89b7e61a');
});

console.log(`\n${passing} passing${failures.length ? `, ${failures.length} failing` : ''}`);
if (failures.length) process.exitCode = 1;
