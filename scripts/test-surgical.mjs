/**
 * Round-trip test for the surgical editors: parse a fixture, write an entry,
 * read it back, and assert that every byte outside the entry survived.
 *
 *   node scripts/test-surgical.mjs
 */

import assert from 'node:assert/strict';
import {
  parseJsonc, readContainer, writeContainerEntry, removeContainerEntry, renameContainerEntry,
  readTomlServers, writeTomlServer, removeTomlServer, readYamlServers,
} from '../lib/surgical.js';

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

console.log('json');

const PLAIN = `{
  "theme": "dark",
  "mcpServers": {
    "alpha": {
      "command": "npx",
      "args": ["-y", "alpha-mcp"]
    }
  },
  "tail": 1
}
`;

check('reads container without touching siblings', () => {
  const read = readContainer(PLAIN, 'mcpServers');
  assert.equal(read.ok, true);
  assert.deepEqual(Object.keys(read.value), ['alpha']);
  assert.equal(read.value.alpha.command, 'npx');
});

check('adds a sibling entry and preserves theme/tail', () => {
  const write = writeContainerEntry(PLAIN, 'mcpServers', 'beta', { command: 'node', args: ['b.js'] });
  assert.equal(write.ok, true);
  const after = JSON.parse(write.text);
  assert.equal(after.theme, 'dark');
  assert.equal(after.tail, 1);
  assert.deepEqual(after.mcpServers.beta, { command: 'node', args: ['b.js'] });
  assert.deepEqual(after.mcpServers.alpha.args, ['-y', 'alpha-mcp']);
});

check('replaces an existing entry in place', () => {
  const write = writeContainerEntry(PLAIN, 'mcpServers', 'alpha', { command: 'uvx', args: [] });
  const after = JSON.parse(write.text);
  assert.equal(after.mcpServers.alpha.command, 'uvx');
  assert.equal(after.theme, 'dark');
});

check('removes the first entry without leaving a dangling comma', () => {
  const write = removeContainerEntry(PLAIN, 'mcpServers', 'alpha');
  assert.equal(write.changed, true);
  const after = JSON.parse(write.text);
  assert.deepEqual(Object.keys(after.mcpServers), []);
  assert.equal(after.tail, 1);
});

check('removes from a two-entry container cleanly', () => {
  const text = `{\n  "mcpServers": {\n    "a": {},\n    "b": {}\n  }\n}\n`;
  const first = removeContainerEntry(text, 'mcpServers', 'a');
  assert.deepEqual(Object.keys(JSON.parse(first.text).mcpServers), ['b']);
  const second = removeContainerEntry(text, 'mcpServers', 'b');
  assert.deepEqual(Object.keys(JSON.parse(second.text).mcpServers), ['a']);
});

check('renames a key without disturbing its value', () => {
  const write = renameContainerEntry(PLAIN, 'mcpServers', 'alpha', 'alpha2');
  const after = JSON.parse(write.text);
  assert.deepEqual(Object.keys(after.mcpServers), ['alpha2']);
  assert.equal(after.mcpServers.alpha2.command, 'npx');
});

check('creates the container when the file has none', () => {
  const write = writeContainerEntry('{\n  "theme": "x"\n}\n', 'mcpServers', 'a', { command: 'c' });
  const after = JSON.parse(write.text);
  assert.equal(after.theme, 'x');
  assert.deepEqual(after.mcpServers.a, { command: 'c' });
});

check('creates the document when the file is empty', () => {
  const write = writeContainerEntry('', 'mcpServers', 'a', { command: 'c' });
  assert.deepEqual(JSON.parse(write.text), { mcpServers: { a: { command: 'c' } } });
});

check('tolerates comments and trailing commas', () => {
  const text = `{
  // my tools
  "mcpServers": {
    "a": { "command": "x" },  /* inline */
  },
}
`;
  const read = readContainer(text, 'mcpServers');
  assert.equal(read.ok, true);
  assert.equal(read.value.a.command, 'x');
  const write = writeContainerEntry(text, 'mcpServers', 'b', { command: 'y' });
  assert.equal(write.ok, true);
  assert.equal(parseJsonc(write.text).value.mcpServers.b.command, 'y');
});

check('preserves CRLF line endings', () => {
  const text = '{\r\n  "mcpServers": {\r\n    "a": { "command": "x" }\r\n  }\r\n}\r\n';
  const write = writeContainerEntry(text, 'mcpServers', 'b', { command: 'y' });
  assert.equal(write.ok, true);
  assert.equal(write.text.includes('\r\n'), true);
  assert.deepEqual(Object.keys(parseJsonc(write.text).value.mcpServers), ['a', 'b']);
});

check('refuses unparsable input instead of destroying it', () => {
  const broken = '{ "mcpServers": { "a": ';
  assert.equal(readContainer(broken, 'mcpServers').ok, false);
  assert.equal(writeContainerEntry(broken, 'mcpServers', 'b', {}).ok, false);
});

console.log('toml');

const TOML = `# Codex CLI
model = "gpt-5"

[mcp_servers.alpha]
command = "npx"
args = ["-y", "alpha-mcp"]

[mcp_servers.beta]
url = "https://example.test/mcp"
startup_timeout_sec = 20

[mcp_servers.alpha.env]
TOKEN = "abc"
`;

check('reads snake_case tables', () => {
  const servers = readTomlServers(TOML);
  assert.deepEqual(Object.keys(servers).sort(), ['alpha', 'beta']);
  assert.equal(servers.alpha.command, 'npx');
  assert.deepEqual(servers.alpha.args, ['-y', 'alpha-mcp']);
  assert.equal(servers.beta.startup_timeout_sec, 20);
  assert.equal(servers.alpha.env.TOKEN, 'abc');
});

check('adds a table without touching existing tables', () => {
  const nextText = writeTomlServer(TOML, 'gamma', { command: 'uvx', args: ['g'] });
  const after = readTomlServers(nextText);
  assert.deepEqual(Object.keys(after).sort(), ['alpha', 'beta', 'gamma']);
  assert.equal(after.gamma.command, 'uvx');
  assert.equal(nextText.includes('model = "gpt-5"'), true);
  assert.equal(nextText.includes('# Codex CLI'), true);
});

check('replaces an existing table wholesale', () => {
  const nextText = writeTomlServer(TOML, 'beta', { url: 'https://new.test/mcp' });
  const after = readTomlServers(nextText);
  assert.equal(after.beta.url, 'https://new.test/mcp');
  assert.equal(after.beta.startup_timeout_sec, undefined);
  assert.equal(after.alpha.command, 'npx');
  assert.equal(nextText.includes('model = "gpt-5"'), true);
});

check('removes a table including its env sub-table', () => {
  const nextText = removeTomlServer(TOML, 'alpha');
  const after = readTomlServers(nextText);
  assert.deepEqual(Object.keys(after), ['beta']);
  assert.equal(nextText.includes('[mcp_servers.alpha.env]'), false);
  assert.equal(nextText.includes('model = "gpt-5"'), true);
  assert.equal(nextText.includes('[mcp_servers.beta]'), true);
});

check('quotes unusual table names', () => {
  const nextText = writeTomlServer(TOML, 'my server', { command: 'x' });
  const after = readTomlServers(nextText);
  assert.equal(after['my server'].command, 'x');
});

console.log('yaml');

check('reads the Continue list form', () => {
  const yaml = `name: cfg
version: 0.0.1
mcpServers:
  - name: alpha
    command: npx
    args:
      - -y
      - alpha-mcp
  - name: beta
    url: https://example.test/mcp
`;
  const servers = readYamlServers(yaml);
  assert.deepEqual(Object.keys(servers).sort(), ['alpha', 'beta']);
  assert.equal(servers.alpha.command, 'npx');
  assert.deepEqual(servers.alpha.args, ['-y', 'alpha-mcp']);
  assert.equal(servers.beta.url, 'https://example.test/mcp');
});

console.log(`\n${pass} passing`);
