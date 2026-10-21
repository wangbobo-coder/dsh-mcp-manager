/**
 * Patch-layer tests against a copy of the real profile composition.
 *
 * The live cordis.patch.yml holds the user's provider config, permission
 * presets and the whole agency-agents block. Everything here checks that those
 * survive byte-for-byte while MCP rows are added and removed.
 *
 *   node scripts/test-dsh-patch.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeDshPatchServer, removeDshPatchServer, splitPatchItems, renderInsertItem, profilePatchPath, patchHasServer, readDshPatchServers } from '../lib/dsh-patch.js';

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

const root = mkdtempSync(join(tmpdir(), 'mcpm-patch-'));
const profileDir = join(root, 'profile');
mkdirSync(profileDir, { recursive: true });
const patchPath = join(profileDir, 'cordis.patch.yml');

const REAL = join(process.env.DSH_PROFILE_DIR ?? join(process.env.DSH_HOME ?? '', 'profiles', 'desktop'), 'cordis.patch.yml');
const hasReal = existsSync(REAL);

/*
 * Seed from the REAL profile so the fixture exercises genuine formatting, but
 * strip any mcp-client rows first: the machine under test may legitimately have
 * servers mounted, and a fixture that already contains one would make the
 * "one row added" and byte-identical assertions meaningless. Slicing the raw
 * text (rather than re-serialising) keeps the user's own spacing intact.
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

if (hasReal) {
  writeFileSync(patchPath, stripMcpRows(readFileSync(REAL, 'utf8')), 'utf8');
} else {
  /* Fall back to a synthetic file with the same shape so the suite still runs. */
  writeFileSync(patchPath, [
    '# Your patch layer for this dsh profile',
    '- id: llm-pi-ai',
    '  name: "@deepseek-ai/dsh-llm-pi-ai"',
    '  config:',
    '    providers:',
    '      deepseek-v4-flash:',
    '        apiKeyEnv: DEEPSEEK_V4_FLASH_API_KEY',
    '- id: agency-agents',
    '  name: "@example/other-plugin"',
    '  config:',
    '    enabled:',
    '      - engineering-ai-engineer',
    '',
  ].join('\n'), 'utf8');
}

const original = readFileSync(patchPath, 'utf8');
const store = {
  backups: [],
  backup(path, text) { this.backups.push({ path, text }); },
};

const SERVER = { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp@latest'] };

console.log(`patch layer (${hasReal ? 'real profile copy' : 'synthetic'}, ${original.length} chars)`);

check('item splitting keeps every top-level entry and the comment preamble', () => {
  const { preamble, items } = splitPatchItems(original);
  assert.ok(preamble.startsWith('#'), 'preamble should hold the leading comment');
  assert.ok(items.length >= 2, `expected several items, got ${items.length}`);
  for (const item of items) assert.match(item.text, /^- /);
});

check('adding a server preserves every other byte of every other entry', () => {
  const result = writeDshPatchServer({ server: SERVER, store, profileDir });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.changed, true);
  const after = readFileSync(patchPath, 'utf8');
  /* Every original line still present, in the same order. */
  const beforeLines = original.split('\n').filter((line) => line.trim());
  let cursor = 0;
  const afterLines = after.split('\n');
  for (const line of beforeLines) {
    const found = afterLines.indexOf(line, cursor);
    assert.ok(found >= 0, `lost or reordered line: ${line}`);
    cursor = found;
  }
  assert.match(after, /id: mcp-context7/);
  assert.match(after, /serverName: "context7"/);
  assert.match(after, /- "@upstash\/context7-mcp@latest"/);
});

check('the new item parses back into a single insert row', () => {
  const after = readFileSync(patchPath, 'utf8');
  const { items } = splitPatchItems(after);
  const ours = items.filter((item) => item.text.includes('mcp-context7'));
  assert.equal(ours.length, 1);
  assert.match(ours[0].text, /^ {4}- id: mcp-context7$/m);
  assert.match(ours[0].text, /^ {6}name: '@deepseek-ai\/dsh-mcp-client'$/m);
});

check('a backup of the pre-write text was taken', () => {
  assert.ok(store.backups.length >= 1);
  assert.equal(store.backups[0].text, original);
});

check('re-applying the same server is a no-op, not a duplicate row', () => {
  const before = readFileSync(patchPath, 'utf8');
  const result = writeDshPatchServer({ server: SERVER, store, profileDir });
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(readFileSync(patchPath, 'utf8'), before);
});

check('re-applying a changed definition replaces the row in place', () => {
  const result = writeDshPatchServer({ server: { ...SERVER, args: ['-y', 'other-mcp'] }, store, profileDir });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const after = readFileSync(patchPath, 'utf8');
  assert.equal(after.match(/id: mcp-context7/g).length, 1, 'must not duplicate the item');
  assert.match(after, /other-mcp/);
  assert.doesNotMatch(after, /@upstash\/context7-mcp/);
});

check('removal drops our item and leaves the user entries intact', () => {
  const result = removeDshPatchServer({ serverName: 'context7', store, profileDir });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  const after = readFileSync(patchPath, 'utf8');
  assert.doesNotMatch(after, /mcp-context7/);
  const { items } = splitPatchItems(after);
  const { items: originalItems } = splitPatchItems(original);
  assert.equal(items.length, originalItems.length, 'entry count should be back to the original');
  for (const item of originalItems) {
    assert.ok(after.includes(item.text.trimEnd()), 'an original entry changed');
  }
  assert.equal(patchHasServer('context7', profileDir), false);
});

check('removing something absent changes nothing', () => {
  const before = readFileSync(patchPath, 'utf8');
  const result = removeDshPatchServer({ serverName: 'never-there', store, profileDir });
  assert.equal(result.changed, false);
  assert.equal(readFileSync(patchPath, 'utf8'), before);
});

check('a hand-written entry that merely looks like ours is not touched', () => {
  /* Same id, but a different package: the user wrote it, so it is theirs. */
  
  const text = `${readFileSync(patchPath, 'utf8')}- insert:\n    - id: mcp-context7\n      name: 'some-other-plugin'\n      config:\n        keep: me\n`;
  writeFileSync(patchPath, text, 'utf8');
  const result = removeDshPatchServer({ serverName: 'context7', store, profileDir });
  assert.equal(result.changed, false, 'must not remove a foreign entry that shares the id');
  assert.match(readFileSync(patchPath, 'utf8'), /keep: me/);
});

check('renderInsertItem quotes values so YAML cannot be broken by a name', () => {
  const { text } = renderInsertItem({ name: 'weird name', transport: 'stdio', command: 'npx', args: ['a"b'] });
  assert.match(text, /serverName: "weird-name"/);
  assert.match(text, /- "a\\"b"/);
});

check('profilePatchPath resolves under the profile dir', () => {
  assert.equal(profilePatchPath('C:\\x\\profiles\\desktop'), join('C:\\x\\profiles\\desktop', 'cordis.patch.yml'));
});

/* --- read-back: pending servers in the patch layer ---------------------- */

const readRoot = mkdtempSync(join(tmpdir(), 'mcpm-read-'));
const readProfile = join(readRoot, 'profile');
mkdirSync(readProfile, { recursive: true });
writeFileSync(join(readProfile, 'cordis.patch.yml'), readFileSync(patchPath, 'utf8'), 'utf8');
const readStore = { backup() {}, recordOwnership() {} };

check('a written server reads back with its command, args and env', () => {
  const written = writeDshPatchServer({
    server: {
      name: 'echo-srv',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'some-mcp', '--flag'],
      env: { API_KEY: 'abc', PORT: '8080' },
      timeoutMs: 45000,
    },
    store: readStore,
    profileDir: readProfile,
  });
  assert.equal(written.ok, true, written.error);
  assert.equal(written.changed, true);
  const found = readDshPatchServers(readProfile).find((server) => server.name === 'echo-srv');
  assert.ok(found, 'the pending server must be readable');
  assert.equal(found.transport, 'stdio');
  assert.equal(found.command, 'npx');
  assert.deepEqual(found.args, ['-y', 'some-mcp', '--flag']);
  assert.equal(found.env.API_KEY, 'abc');
  assert.equal(found.env.PORT, '8080');
  assert.equal(found.timeoutMs, 45000);
  assert.equal(found.pending, true);
});

check('an http server reads back with its url and headers', () => {
  writeDshPatchServer({
    server: { name: 'remote-srv', transport: 'http-stream', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
    store: readStore,
    profileDir: readProfile,
  });
  const found = readDshPatchServers(readProfile).find((server) => server.name === 'remote-srv');
  assert.ok(found);
  assert.equal(found.transport, 'http-stream');
  assert.equal(found.url, 'https://example.test/mcp');
  assert.equal(found.headers.Authorization, 'Bearer t');
});

check('other patch entries are not mistaken for MCP servers', () => {
  const names = readDshPatchServers(readProfile).map((server) => server.name);
  assert.equal(names.includes('mcp-manager'), false, 'the plugin own insert must be ignored');
});

check('removing a pending server makes it unreadable again', () => {
  const result = removeDshPatchServer({ serverName: 'echo-srv', store: readStore, profileDir: readProfile });
  assert.equal(result.changed, true);
  assert.equal(readDshPatchServers(readProfile).some((server) => server.name === 'echo-srv'), false);
});

console.log(`\n${pass} passing`);
