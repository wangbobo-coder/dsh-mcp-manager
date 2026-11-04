/**
 * Manual-add test: the path where a server is created from a pasted JSON
 * configuration instead of being read out of a tool's own file.
 *
 * Asserts the four accepted wrappers (Trae/Cursor `mcpServers`, VS Code
 * `servers`, OpenCode `mcp`, Zed `context_servers`), the bare-map and
 * single-entry shapes, per-entry validation and refusals, cross-tool dialect
 * translation (a Trae-shaped paste written into Windsurf / OpenCode / DSH), the
 * batch hash carry (writing several entries must not trip the conflict guard on
 * the second one), and the lossless-JSON normalization the agent tool needs.
 *
 *   node scripts/test-add.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.js';
import { addServers, parseServerConfig } from '../lib/ops.js';
import { toLosslessJson } from '../lib/index.js';
import { patchHasServer } from '../lib/dsh-patch.js';

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

const root = mkdtempSync(join(tmpdir(), 'mcpm-add-'));
const store = createStore({ root: join(root, 'state'), backupsToKeep: 5 });
store.ensureDirs();
const profileDir = join(root, 'profile');

/** A Trae / Cursor / Claude shaped configuration — the shape users paste. */
const TRAE_CONFIG = `{
  "mcpServers": {
    "local-demo": {
      "command": "npx",
      "args": ["-y", "demo-mcp"],
      "env": { "DEMO_TOKEN": "\${env:DEMO_TOKEN}" }
    }
  }
}`;

console.log('parsing');

await check('reads the Trae/Cursor/Claude mcpServers wrapper', () => {
  const parsed = parseServerConfig(TRAE_CONFIG);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0].name, 'local-demo');
  assert.equal(parsed.entries[0].raw.command, 'npx');
});

await check('reads the VS Code, OpenCode and Zed wrappers', () => {
  for (const key of ['servers', 'mcp', 'context_servers']) {
    const parsed = parseServerConfig(JSON.stringify({ [key]: { demo: { command: 'node' } } }));
    assert.equal(parsed.ok, true, `${key}: ${JSON.stringify(parsed)}`);
    assert.equal(parsed.entries[0].name, 'demo');
  }
});

await check('reads a bare name → entry map', () => {
  const parsed = parseServerConfig({ alpha: { command: 'npx' }, beta: { url: 'https://example.test/mcp' } });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.deepEqual(parsed.entries.map((entry) => entry.name).sort(), ['alpha', 'beta']);
});

await check('reads one bare entry that carries its own name', () => {
  const parsed = parseServerConfig({ name: 'solo', command: 'npx', args: ['-y', 'solo-mcp'] });
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  assert.equal(parsed.entries[0].name, 'solo');
  assert.equal(parsed.entries[0].raw.name, undefined, 'name must not leak into the encoded entry');
});

await check('reads an already-parsed object as well as text', () => {
  const parsed = parseServerConfig({ mcpServers: { objectDemo: { command: 'node' } } });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries[0].name, 'objectDemo');
});

await check('rejects invalid JSON with a readable reason', () => {
  const parsed = parseServerConfig('{ "mcpServers": { ');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'error.input.json');
});

await check('rejects an empty paste', () => {
  const parsed = parseServerConfig('   ');
  assert.equal(parsed?.ok, false);
});

await check('rejects a configuration with no server entries', () => {
  const parsed = parseServerConfig('{ "something": "else" }');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'error.input.json');
});

await check('rejects an array', () => {
  const parsed = parseServerConfig('[1, 2]');
  assert.equal(parsed.ok, false);
});

console.log('writing into a tool config');

await check('creates a JSON config file from a pasted definition', async () => {
  const path = join(root, 'cursor', 'mcp.json');
  const result = await addServers({ store }, { target: { clientId: 'cursor', scope: 'global', path }, config: TRAE_CONFIG });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.added, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.results[0].name, 'local-demo');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after.mcpServers['local-demo'].args, ['-y', 'demo-mcp']);
  assert.equal(after.mcpServers['local-demo'].env.DEMO_TOKEN, '${env:DEMO_TOKEN}');
});

await check('writes several entries in one paste, carrying the hash forward', async () => {
  const path = join(root, 'trae', 'mcp.json');
  mkdirSync(join(root, 'trae'), { recursive: true });
  const config = JSON.stringify({
    mcpServers: {
      one: { command: 'npx', args: ['-y', 'one'] },
      two: { command: 'node', args: ['two.js'] },
      three: { url: 'https://example.test/mcp' },
    },
  });
  const result = await addServers({ store }, { target: { clientId: 'trae', scope: 'global', path }, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.added, 3, JSON.stringify(result.results));
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(Object.keys(after.mcpServers).sort(), ['one', 'three', 'two']);
});

await check('translates a Trae-shaped remote paste into Windsurf\'s serverUrl', async () => {
  const path = join(root, 'windsurf', 'mcp_config.json');
  mkdirSync(join(root, 'windsurf'), { recursive: true });
  writeFileSync(path, '{ "mcpServers": {} }\n', 'utf8');
  const config = JSON.stringify({ mcpServers: { 'trae-remote': { url: 'https://example.test/mcp', headers: { 'X-Trace': '1' } } } });
  const result = await addServers({ store }, { target: { clientId: 'windsurf', scope: 'global', path }, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.mcpServers['trae-remote'].serverUrl, 'https://example.test/mcp');
  assert.equal(after.mcpServers['trae-remote'].url, undefined);
});

await check('translates the same paste into OpenCode\'s array command and environment map', async () => {
  const path = join(root, 'opencode', 'opencode.json');
  mkdirSync(join(root, 'opencode'), { recursive: true });
  writeFileSync(path, '{ "mcp": {} }\n', 'utf8');
  const config = JSON.stringify({ mcpServers: { 'trae-local': { command: 'npx', args: ['-y', 'demo'], env: { DEMO_TOKEN: '${env:DEMO_TOKEN}' } } } });
  const result = await addServers({ store }, { target: { clientId: 'opencode', scope: 'global', path }, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after.mcp['trae-local'].command, ['npx', '-y', 'demo']);
  assert.equal(after.mcp['trae-local'].type, 'local');
  assert.equal(after.mcp['trae-local'].environment.DEMO_TOKEN, '${env:DEMO_TOKEN}');
});

await check('refuses a name that already exists and still writes the rest', async () => {
  const path = join(root, 'cursor', 'mcp.json');
  const config = JSON.stringify({
    mcpServers: {
      'local-demo': { command: 'npx', args: ['-y', 'changed'] },
      fresh: { command: 'node' },
    },
  });
  const result = await addServers({ store }, { target: { clientId: 'cursor', scope: 'global', path }, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.added, 1);
  assert.equal(result.failed, 1);
  const refused = result.results.find((item) => !item.ok);
  assert.equal(refused.displayName, 'local-demo');
  assert.equal(refused.code, 'error.server.exists');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after.mcpServers['local-demo'].args, ['-y', 'demo-mcp'], 'the existing entry must not be overwritten');
  assert.equal(after.mcpServers.fresh.command, 'node');
});

await check('reports a per-entry validation failure instead of refusing the whole paste', async () => {
  const path = join(root, 'validation', 'mcp.json');
  mkdirSync(join(root, 'validation'), { recursive: true });
  const config = JSON.stringify({ mcpServers: { 'no-command': { args: ['x'] }, good: { command: 'node' } } });
  const result = await addServers({ store }, { target: { clientId: 'trae', scope: 'global', path }, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.added, 1);
  const refused = result.results.find((item) => !item.ok);
  assert.equal(refused.code, 'error.input.command');
});

await check('refuses everything when nothing can be written, with the first reason', async () => {
  const path = join(root, 'nothing', 'mcp.json');
  mkdirSync(join(root, 'nothing'), { recursive: true });
  const config = JSON.stringify({ mcpServers: { broken: { args: ['x'] } } });
  const result = await addServers({ store }, { target: { clientId: 'trae', scope: 'global', path }, config });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.input.command');
  assert.equal(existsSync(path), false, 'a refused paste must not create the file');
});

await check('refuses a literal credential in a project-scope file', async () => {
  const path = join(root, 'project', '.mcp.json');
  mkdirSync(join(root, 'project'), { recursive: true });
  writeFileSync(path, '{ "mcpServers": {} }\n', 'utf8');
  const config = JSON.stringify({ mcpServers: { leaked: { command: 'npx', env: { API_KEY: 'sk-live-abcdef1234567890' } } } });
  const result = await addServers({ store }, { target: { clientId: 'claude-code', scope: 'project', path }, config });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.secret.projectScope');
  assert.equal(readFileSync(path, 'utf8'), '{ "mcpServers": {} }\n');
});

await check('resolves a project-scope target from the workspace root when no path is given', async () => {
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const config = JSON.stringify({ mcpServers: { 'workspace-demo': { command: 'npx' } } });
  const result = await addServers({ store }, { target: { clientId: 'claude-code', scope: 'project', projectRoots: [workspace] }, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  const written = JSON.parse(readFileSync(join(workspace, '.mcp.json'), 'utf8'));
  assert.equal(written.mcpServers['workspace-demo'].command, 'npx');
});

await check('refuses a name the target file cannot hold', async () => {
  const path = join(root, 'cjk', 'mcp.json');
  mkdirSync(join(root, 'cjk'), { recursive: true });
  const config = JSON.stringify({ mcpServers: { '示例服务器': { command: 'npx' } } });
  const result = await addServers({ store }, { target: { clientId: 'trae', scope: 'global', path }, config });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.input.name');
});

console.log('DeepSeek Harness target');

await check('creates a profile patch row from a pasted configuration', async () => {
  assert.equal(patchHasServer('patch-demo', profileDir), false);
  const config = JSON.stringify({ mcpServers: { 'patch-demo': { command: 'npx', args: ['-y', 'demo-mcp'] } } });
  const result = await addServers({ store, profileDir }, { target: { clientId: 'dsh', scope: 'profile' }, config });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(patchHasServer('patch-demo', profileDir), true);
  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.includes('@deepseek-ai/dsh-mcp-client'), patch);
  assert.ok(patch.includes('serverName: "patch-demo"'), patch);
});

await check('a second paste of the same name is refused, not duplicated', async () => {
  const config = JSON.stringify({ mcpServers: { 'patch-demo': { command: 'node' } } });
  const result = await addServers({ store, profileDir }, { target: { clientId: 'dsh', scope: 'profile' }, config });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.server.exists');
  const patch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8');
  assert.equal((patch.match(/serverName: "patch-demo"/g) ?? []).length, 1, patch);
});

await check('records a backup and a ledger entry for every write', async () => {
  const writes = store.recentWrites(20);
  assert.ok(writes.length >= 4, `expected writes, got ${writes.length}`);
  assert.ok(store.listBackups(20).length >= 1, 'expected at least one backup');
});

/*
 * The agent tool validates its answer as LOSSLESS JSON. A scan snapshot carries
 * hundreds of `undefined` fields (canonical model internals), so a raw result
 * used to kill the whole tool with "value is not lossless JSON" — including
 * `scan`, which long predates the add action. This is the guard for that.
 */
console.log('lossless tool output');

await check('drops undefined fields instead of failing the tool', () => {
  const out = toLosslessJson({ url: undefined, kept: 1, nested: { cwd: undefined } });
  assert.deepEqual(out, { kept: 1, nested: {} });
});

await check('turns array holes into null rather than leaving them undefined', () => {
  assert.deepEqual(toLosslessJson([1, undefined, 3]), [1, null, 3]);
});

await check('normalizes non-finite numbers and Dates', () => {
  const out = toLosslessJson({ nan: Number.NaN, inf: Infinity, at: new Date('2026-11-04T00:00:00.000Z') });
  assert.equal(out.nan, null);
  assert.equal(out.inf, null);
  assert.equal(out.at, '2026-11-04T00:00:00.000Z');
});

await check('survives a cycle instead of throwing mid-answer', () => {
  const node = { name: 'loop' };
  node.self = node;
  const out = toLosslessJson(node);
  assert.equal(out.name, 'loop');
  assert.equal(out.self, '[circular]');
});

console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`);
