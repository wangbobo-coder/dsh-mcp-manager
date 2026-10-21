/**
 * Write-path test against real config shapes: copy a real client file into a
 * temp directory, then apply, re-apply, and remove a server through the same
 * store + ops path the UI uses. Asserts the surrounding bytes survive and the
 * conflict guard actually fires.
 *
 *   node scripts/test-write.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.js';
import { applyServerToTarget, removeServerFromTarget } from '../lib/ops.js';
import { resolveClientPaths } from '../lib/adapters.js';
import { CLIENT_BY_ID } from '../lib/adapters.js';

let pass = 0;
async function check(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
    process.exitCode = 1;
  }
}

const root = mkdtempSync(join(tmpdir(), 'mcpm-write-'));
const store = createStore({ root: join(root, 'state'), backupsToKeep: 5 });
store.ensureDirs();

/** Copy a real config into a scratch path and return that path. */
function scratch(clientId, sourcePath) {
  const client = CLIENT_BY_ID.get(clientId);
  const original = resolveClientPaths(client, undefined).find((item) => item.scope === 'global');
  const target = join(root, clientId, original.path.replace(/^[A-Za-z]:[\\/]/, '').replace(/[\\/]/g, '_'));
  mkdirSync(dirname(target), { recursive: true });
  if (sourcePath && existsSync(sourcePath)) copyFileSync(sourcePath, target);
  return target;
}

const SERVER = {
  name: 'probe-server',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'probe-mcp'],
  env: { PROBE_TOKEN: '${env:PROBE_TOKEN}' },
  enabled: true,
};

console.log('json write path (opencode shape, real file copy)');

const opencodePath = scratch('opencode', join(process.env.USERPROFILE ?? '', '.config', 'opencode', 'opencode.json'));

await check('adds an entry to the real opencode root key and keeps every other subsection', async () => {
  const before = readFileSync(opencodePath, 'utf8');
  const beforeJson = JSON.parse(before);
  const result = await applyServerToTarget({ store }, {
    clientId: 'opencode',
    scope: 'global',
    path: opencodePath,
    server: SERVER,
    expectedHash: store.hashOf(before),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(readFileSync(opencodePath, 'utf8'));
  assert.deepEqual(Object.keys(after).sort(), Object.keys(beforeJson).sort());
  assert.equal(after.$schema, beforeJson.$schema);
  assert.deepEqual(Object.keys(after.mcp).sort(), [...Object.keys(beforeJson.mcp), 'probe-server'].sort());
  assert.equal(after.mcp['probe-server'].type, 'local');
  assert.deepEqual(after.mcp['probe-server'].command, ['npx', '-y', 'probe-mcp']);
  assert.equal(after.mcp['probe-server'].environment.PROBE_TOKEN, '${env:PROBE_TOKEN}');
  assert.deepEqual(after.plugin, beforeJson.plugin);
});

await check('refuses the second write when the hash no longer matches (conflict guard)', async () => {
  const staleHash = store.hashOf(readFileSync(opencodePath, 'utf8'));
  writeFileSync(opencodePath, `${readFileSync(opencodePath, 'utf8')}\n`, 'utf8');
  const result = await applyServerToTarget({ store }, {
    clientId: 'opencode',
    scope: 'global',
    path: opencodePath,
    server: SERVER,
    expectedHash: staleHash,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.file.conflict');
  assert.ok(result.conflict.actual);
});

await check('removes the entry again, leaving the rest intact', async () => {
  const text = readFileSync(opencodePath, 'utf8');
  const before = JSON.parse(text);
  const result = removeServerFromTarget({ store }, {
    clientId: 'opencode',
    scope: 'global',
    path: opencodePath,
    name: 'probe-server',
    expectedHash: store.hashOf(text),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(readFileSync(opencodePath, 'utf8'));
  assert.equal(after.mcp['probe-server'], undefined);
  assert.deepEqual(Object.keys(after.mcp).sort(), Object.keys(before.mcp).filter((key) => key !== 'probe-server').sort());
  assert.equal(after.$schema, before.$schema);
});

await check('records a backup and a ledger entry for each write', async () => {
  const writes = store.recentWrites(10);
  assert.ok(writes.length >= 2, `expected writes, got ${writes.length}`);
  assert.ok(writes.some((entry) => entry.backup), 'expected a backup path on the write record');
  const backups = store.listBackups(10);
  assert.ok(backups.length >= 1);
});

console.log('project-scope guard');

await check('refuses to write a literal credential into a project-scope file', async () => {
  const path = join(root, 'project', '.mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{}\n', 'utf8');
  const result = await applyServerToTarget({ store }, {
    clientId: 'claude-code',
    scope: 'project',
    path,
    server: { ...SERVER, env: { API_KEY: 'sk-live-abcdef1234567890' } },
    expectedHash: store.hashOf('{}\n'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.secret.projectScope');
  assert.equal(readFileSync(path, 'utf8'), '{}\n', 'file must be untouched');
});

await check('allows the same definition at global scope', async () => {
  const path = join(root, 'claude', '.claude.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{\n  "numStartups": 3,\n  "mcpServers": {}\n}\n', 'utf8');
  const result = await applyServerToTarget({ store }, {
    clientId: 'claude-code',
    scope: 'global',
    path,
    server: { ...SERVER, env: { API_KEY: 'sk-live-abcdef1234567890' } },
    expectedHash: store.hashOf(readFileSync(path, 'utf8')),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.numStartups, 3);
  assert.equal(after.mcpServers['probe-server'].env.API_KEY, 'sk-live-abcdef1234567890');
});

await check('claude-code entries carry an explicit type so the client does not skip them', async () => {
  const path = join(root, 'claude2', '.claude.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "mcpServers": {} }\n', 'utf8');
  await applyServerToTarget({ store }, {
    clientId: 'claude-code',
    scope: 'global',
    path,
    server: SERVER,
    expectedHash: store.hashOf('{ "mcpServers": {} }\n'),
  });
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.mcpServers['probe-server'].type, 'stdio');
});

console.log('windsurf serverUrl quirk');

await check('writes serverUrl (not url) for a remote server in Windsurf', async () => {
  const path = join(root, 'windsurf', 'mcp_config.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "mcpServers": {} }\n', 'utf8');
  const result = await applyServerToTarget({ store }, {
    clientId: 'windsurf',
    scope: 'global',
    path,
    server: { name: 'remote-one', transport: 'http', url: 'https://example.test/mcp', enabled: true },
    expectedHash: store.hashOf('{ "mcpServers": {} }\n'),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.mcpServers['remote-one'].serverUrl, 'https://example.test/mcp');
  assert.equal(after.mcpServers['remote-one'].url, undefined);
});

console.log('idempotence');

await check('writing the same definition twice changes nothing the second time', async () => {
  const path = join(root, 'idem', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "mcpServers": {} }\n', 'utf8');
  const first = await applyServerToTarget({ store }, { clientId: 'trae', scope: 'global', path, server: SERVER,
    expectedHash: store.hashOf('{ "mcpServers": {} }\n'),
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const text = readFileSync(path, 'utf8');
  const second = await applyServerToTarget({ store }, { clientId: 'trae', scope: 'global', path, server: SERVER,
    expectedHash: store.hashOf(text),
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.changed, false, 'second identical write should report no change');
  assert.equal(readFileSync(path, 'utf8'), text);
});

console.log('name collisions');

await check('a foreign server on the same name gets our copy suffixed, not overwritten', async () => {
  const path = join(root, 'collide', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  const original = { mcpServers: { 'probe-server': { command: 'someone-elses-binary', args: ['--theirs'] } } };
  writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
  const result = await applyServerToTarget({ store }, {
    clientId: 'trae', scope: 'global', path, server: SERVER,
    expectedHash: store.hashOf(readFileSync(path, 'utf8')),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.name, 'probe-server-2');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after.mcpServers['probe-server'], original.mcpServers['probe-server'], 'foreign entry must be untouched');
  assert.equal(after.mcpServers['probe-server-2'].command, 'npx');
});

await check('a server we wrote earlier is updated in place when the definition changes', async () => {
  const path = join(root, 'owned', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "mcpServers": {} }\n', 'utf8');
  const first = await applyServerToTarget({ store }, {
    clientId: 'trae', scope: 'global', path, server: SERVER,
    expectedHash: store.hashOf('{ "mcpServers": {} }\n'),
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const edited = { ...SERVER, args: ['-y', 'probe-mcp@latest'] };
  const second = await applyServerToTarget({ store }, {
    clientId: 'trae', scope: 'global', path, server: edited,
    expectedHash: store.hashOf(readFileSync(path, 'utf8')),
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.name, 'probe-server', 'must update in place, not suffix');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers), ['probe-server']);
  assert.deepEqual(after.mcpServers['probe-server'].args, ['-y', 'probe-mcp@latest']);
});

await check('a server we wrote but the user then edited is treated as foreign', async () => {
  const path = join(root, 'user-edited', 'mcp.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '{ "mcpServers": {} }\n', 'utf8');
  await applyServerToTarget({ store }, {
    clientId: 'trae', scope: 'global', path, server: SERVER,
    expectedHash: store.hashOf('{ "mcpServers": {} }\n'),
  });
  const edited = JSON.parse(readFileSync(path, 'utf8'));
  edited.mcpServers['probe-server'].command = 'user-changed-this';
  writeFileSync(path, `${JSON.stringify(edited, null, 2)}\n`, 'utf8');
  const result = await applyServerToTarget({ store }, {
    clientId: 'trae', scope: 'global', path, server: SERVER,
    expectedHash: store.hashOf(readFileSync(path, 'utf8')),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.name, 'probe-server-2', 'a user-edited entry must not be silently flattened');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.mcpServers['probe-server'].command, 'user-changed-this');
});

console.log(`\n${pass} passing`);
