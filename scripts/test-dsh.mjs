/**
 * DSH self-adapter tests against a stand-in `configEditor`.
 *
 * The real one owns a live Loader, so this exercises the same contract shape
 * (`configuration()` / `edit(entry, change)`) without touching the running
 * profile: the decode/replace/remove logic is what needs proving, and the real
 * service is already proven by the fact that the profile loads at all.
 *
 *   node scripts/test-dsh.mjs
 */

import assert from 'node:assert/strict';
import { mcpEntries, decodeDshEntry, encodeDshEntry, upsertDshServer, removeDshServer, dshSnippet, MCP_CLIENT_PACKAGE } from '../lib/dsh.js';

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
    process.exitCode = 1;
  }
}

function fakeEditor(rows) {
  const state = rows.map((row) => ({ ...row }));
  return {
    state,
    configuration() {
      return state.map((row) => ({ entry: row.entry, inherited: row.inherited ?? {}, override: row.override ?? {} }));
    },
    async edit(entry, change) {
      const index = state.findIndex((row) => row.entry === entry || row.entry.id === entry.id);
      if (index < 0) throw new Error('entry not found');
      const current = state[index];
      current.override = change({ ...current.inherited, ...current.override }, current.inherited);
    },
  };
}

/*
 * Mirror the LIVE Loader entry, which has no `name` of its own: the package it
 * instantiates lives at `entry.options.name`. The earlier stub set `entry.name`
 * and so could never have caught the real mismatch (bug: discovery silently
 * returned zero rows on a running Host, making every DSH server look pending).
 */
const entry = (id, extra = {}) => ({ id, options: { name: MCP_CLIENT_PACKAGE }, ...extra });

console.log('row discovery');

check('finds rows shaped like the live Loader (entry.options.name, no entry.name)', () => {
  const editor = fakeEditor([
    { entry: entry('mcp-a'), override: { serverName: 'a', transport: 'stdio', command: 'npx' } },
  ]);
  const rows = mcpEntries(editor);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entry.name, undefined);
});

check('still accepts a Loader that exposes entry.name directly', () => {
  const editor = fakeEditor([
    { entry: { id: 'mcp-c', name: MCP_CLIENT_PACKAGE }, override: { serverName: 'c', transport: 'stdio', command: 'npx' } },
  ]);
  assert.equal(mcpEntries(editor).length, 1);
});

check('finds mcp-client rows and ignores everything else', () => {
  const editor = fakeEditor([
    { entry: entry('mcp-a'), override: { serverName: 'a', transport: 'stdio', command: 'npx' } },
    { entry: { id: 'ui-chat', name: '@deepseek-ai/dsh-client-ui-chat' }, override: {} },
    { entry: entry('mcp-b'), override: { serverName: 'b', transport: 'streamable-http', url: 'https://x.test/mcp' } },
  ]);
  assert.equal(mcpEntries(editor).length, 2);
});

check('returns nothing when configEditor is absent or throws', () => {
  assert.deepEqual(mcpEntries(undefined), []);
  assert.deepEqual(mcpEntries({ configuration() { throw new Error('boom'); } }), []);
});

console.log('decoding');

check('stdio row decodes to the canonical model', () => {
  const server = decodeDshEntry(entry('mcp-a'), {
    serverName: 'alpha',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { API_TOKEN: 'short' },
    toolCallTimeoutMs: 15000,
  });
  assert.equal(server.name, 'alpha');
  assert.equal(server.transport, 'stdio');
  assert.deepEqual(server.args, ['-y', 'pkg']);
  assert.equal(server.timeoutMs, 15000);
  assert.equal(server.enabled, true);
  /* A short value is not treated as a credential — the heuristic needs length. */
  assert.deepEqual(server.secrets, []);
});

check('streamable-http decodes to http-stream and keeps headers', () => {
  const server = decodeDshEntry(entry('mcp-b'), {
    serverName: 'beta',
    transport: 'streamable-http',
    url: 'https://x.test/mcp',
    headers: { Authorization: 'Bearer abcdefghijklmnop' },
  });
  assert.equal(server.transport, 'http-stream');
  assert.equal(server.url, 'https://x.test/mcp');
  assert.deepEqual(server.secrets.map((item) => item.key), ['Authorization']);
});

check('a disabled row decodes as disabled', () => {
  const server = decodeDshEntry(entry('mcp-c', { disabled: true }), { serverName: 'gamma', transport: 'stdio', command: 'x' });
  assert.equal(server.enabled, false);
});

console.log('encoding');

check('stdio encoding emits only the fields mcp-client accepts', () => {
  const config = encodeDshEntry({
    name: 'my server!',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'pkg'],
    env: { A: '1' },
    timeoutMs: 30000,
  });
  assert.equal(config.serverName, 'my-server');
  assert.equal(config.transport, 'stdio');
  assert.equal(config.command, 'npx');
  assert.deepEqual(config.args, ['-y', 'pkg']);
  assert.deepEqual(config.env, { A: '1' });
  assert.equal(config.toolCallTimeoutMs, 30000);
  /* These do not exist in the schema and must never be invented. */
  assert.equal(config.url, undefined);
  assert.equal(config.autoApprove, undefined);
  assert.equal(config.enabled, undefined);
});

check('http encoding writes url + headers, never a command', () => {
  const config = encodeDshEntry({
    name: 'remote',
    transport: 'http-stream',
    url: 'https://x.test/mcp',
    headers: { 'X-Key': 'v' },
    command: '/usr/bin/ignored',
  });
  assert.equal(config.transport, 'streamable-http');
  assert.equal(config.url, 'https://x.test/mcp');
  assert.equal(config.command, undefined);
  assert.deepEqual(config.headers, { 'X-Key': 'v' });
});

check('a sse transport is downgraded to streamable-http (no sse here)', () => {
  assert.equal(encodeDshEntry({ name: 'x', transport: 'http-sse', url: 'u' }).transport, 'streamable-http');
});

console.log('writing');

await check('replacing an existing row merges into that row and keeps unrelated config', () => {
  const editor = fakeEditor([
    { entry: entry('mcp-a'), override: { serverName: 'alpha', transport: 'stdio', command: 'old', failOnStartupError: true } },
  ]);
  const previous = mcpEntries(editor)[0];
  return upsertDshServer(editor, { server: { name: 'alpha', transport: 'stdio', command: 'new', args: ['-x'] }, previous }).then((result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    const saved = editor.state[0].override;
    assert.equal(saved.command, 'new');
    assert.deepEqual(saved.args, ['-x']);
    assert.equal(saved.failOnStartupError, true, 'unrelated inherited config must survive');
    assert.equal(editor.state[0].entry.id, 'mcp-a', 'the row id must not change');
  });
});

await check('refuses a duplicate serverName held by a different row', () => {
  const editor = fakeEditor([
    { entry: entry('mcp-a'), override: { serverName: 'alpha', transport: 'stdio', command: 'x' } },
    { entry: entry('mcp-b'), override: { serverName: 'beta', transport: 'stdio', command: 'y' } },
  ]);
  const previous = mcpEntries(editor).find((row) => row.entry.id === 'mcp-b');
  return upsertDshServer(editor, { server: { name: 'alpha', transport: 'stdio', command: 'z' }, previous }).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'error.dsh.duplicateName');
  });
});

await check('a too-long name is coerced and reported, never silently renamed', () => {
  const editor = fakeEditor([
    { entry: entry('mcp-a'), override: { serverName: 'alpha', transport: 'stdio', command: 'x' } },
  ]);
  const previous = mcpEntries(editor)[0];
  return upsertDshServer(editor, {
    server: { name: 'this-name-is-far-too-long-for-the-schema', transport: 'stdio', command: 'x' },
    previous,
  }).then((result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.renamed, 'the rename must be reported');
    assert.equal(result.renamed.from, 'this-name-is-far-too-long-for-the-schema');
    assert.equal(result.renamed.to.length, 32);
    assert.equal(editor.state[0].override.serverName, result.renamed.to);
  });
});

await check('a new row is refused with an actionable code, not a crash', () => {
  const editor = fakeEditor([]);
  return upsertDshServer(editor, { server: { name: 'fresh', transport: 'stdio', command: 'x' } }).then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.code, 'error.dsh.insertUnsupported');
  });
});

await check('removal blanks the row config', () => {
  const editor = fakeEditor([
    { entry: entry('mcp-a'), override: { serverName: 'alpha', transport: 'stdio', command: 'x' } },
  ]);
  const row = mcpEntries(editor)[0];
  return removeDshServer(editor, row).then((result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(editor.state[0].override.serverName, undefined);
  });
});

console.log('snippet');

check('snippet is a patch row that parses as the documented shape', () => {
  const yaml = dshSnippet({ name: 'alpha', transport: 'stdio', command: 'npx', args: ['-y', 'pkg'] });
  assert.match(yaml, /^- insert:/m);
  assert.match(yaml, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(yaml, /serverName: "alpha"/);
  assert.match(yaml, /^ {10}- "-y"$/m);
});

console.log(`\n${pass} passing`);
