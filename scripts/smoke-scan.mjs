/**
 * Scan this machine's real client configs and print what the UI would show.
 * Read-only: nothing here writes to any client file.
 *
 *   node scripts/smoke-scan.mjs
 */

import { createStore } from '../lib/store.js';
import { scanAll } from '../lib/scan.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const store = createStore({ root: join(tmpdir(), 'mcpm-scan', 'state'), backupsToKeep: 3 });
const result = await scanAll({ store, configEditor: null, projectRoots: [], reveal: false });

const installed = result.clients.filter((client) => client.installed);
const absent = result.clients.filter((client) => !client.installed);

console.log(`clients: ${result.clients.length} total, ${installed.length} installed, ${absent.length} not installed`);
console.log(`servers: ${result.servers.length}`);
console.log('');

for (const client of installed) {
  console.log(`${client.label.en.padEnd(16)} ${String(client.serverCount).padStart(2)}  ${client.locations.map((l) => l.path).join(' | ')}`);
}

console.log('\nmatrix:');
for (const node of result.servers) {
  const where = node.targets.map((t) => `${t.clientId}${t.enabled === false ? '(off)' : ''}`).join(', ');
  const secret = node.secrets.length ? `  SECRETS[${node.secrets.map((item) => item.key).join(',')}]` : '';
  console.log(`  ${node.name.padEnd(28)} ${node.transport.padEnd(12)} ${where}${secret}`);
}

if (result.warnings.length) {
  console.log('\nwarnings:');
  for (const warning of result.warnings) console.log(`  ${warning.code ?? 'warn'}: ${warning.path ?? ''} ${warning.error ?? ''}`);
}

if (result.literalSecrets.length) {
  console.log('\nplaintext credentials found on disk:');
  for (const item of result.literalSecrets) console.log(`  ${item.clientId} ${item.server} ${item.where}.${item.key} ${item.path}`);
}

/*
 * Redaction must hold everywhere a literal can hide — env, headers, unmodelled
 * `extra`, and the raw entry copy. Walking the whole payload is the only way to
 * prove no token escaped, because a leak in `raw` is invisible in the summary.
 */
const payload = JSON.stringify({ servers: result.servers, clients: result.clients, locations: result.locations, warnings: result.warnings });

/**
 * Recover the real credential from the file for one finding.
 *
 * The value's shape depends on where it lives: a map entry is `"KEY": "value"`,
 * while a command-line credential is either glued to its flag (`--key=value`)
 * or the following array element. A check that only understood the map shape
 * silently passed while an args literal sat in the payload.
 */
function literalFor(text, item) {
  const key = item.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (item.where === 'args') {
    const inline = new RegExp(`${key}=([^"'\\\\\\s]+)`).exec(text);
    if (inline) return inline[1];
    const separate = new RegExp(`"${key}"\\s*,\\s*"([^"]+)"`).exec(text);
    if (separate) return separate[1];
    return null;
  }
  const map = new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`).exec(text);
  return map ? map[1] : null;
}

const leaks = [];
for (const item of result.literalSecrets) {
  const client = result.clients.find((candidate) => candidate.id === item.clientId);
  if (!client) continue;
  for (const location of client.locations ?? []) {
    let text = '';
    try { text = readFileSync(location.path, 'utf8'); } catch { continue; }
    const literal = literalFor(text, item);
    // Ignore references and short values: they are meant to be readable.
    if (!literal || literal.length < 12 || /^\$\{|\{env:/.test(literal)) continue;
    if (payload.includes(literal)) leaks.push(`${item.server}/${item.where}.${item.key}`);
  }
}
if (!result.literalSecrets.some((item) => item.where === 'args')) {
  console.log('note: no command-line credential on this machine, args redaction not exercised here');
}
console.log(`\nredaction check: ${leaks.length === 0 ? 'ok — no credential literal in payload' : `FAIL — leaked: ${leaks.join(', ')}`}`);
if (leaks.length) process.exitCode = 1;

const secretNamesVisible = result.servers.every((node) => Array.isArray(node.secrets));
console.log(`secret key names still visible to the UI: ${secretNamesVisible ? 'ok' : 'FAIL'}`);
if (!secretNamesVisible) process.exitCode = 1;
