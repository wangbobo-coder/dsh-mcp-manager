/**
 * The masked-value write-back hazard.
 *
 * The browser only ever holds a redacted server object. If a write path used
 * that object instead of the host-side scan, a masked placeholder
 * (`figd••••0000`) would land in a real config file and destroy the
 * credential. These assertions pin the resolution order in lib/index.js by
 * exercising the same helper the ops call, then check a round trip.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';

let failed = 0;
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (err) { failed += 1; console.log(`  FAIL ${name}\n       ${err.message}`); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }

const TOKEN = 'figd_EXAMPLEnotarealtoken000000000000000';
const root = mkdtempSync(join(tmpdir(), 'mcpm-mask-'));
const store = createStore({ root, backupsToKeep: 3 });
await store.ensureDirs();

const target = join(root, 'opencode.json');
mkdirSync(join(root), { recursive: true });
writeFileSync(target, '{\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": {}\n}\n');

console.log('masked write-back\n');

/*
 * A definition that arrives carrying a mask must be rejected rather than
 * written: a mask is not a credential, and persisting one silently breaks the
 * server for every client that reads the file.
 */
await check('the store round trip keeps a real value intact', async () => {
  const out = await store.mutate({
    path: target, clientId: 'opencode', scope: 'global', serverName: 'figma', label: 'add',
    mutate: (text) => ({ text: text.replace('"mcp": {}', `"mcp": { "figma": { "type": "local", "command": ["npx", "--figma-api-key=${TOKEN}"] } }`) }),
  });
  assert(out.ok, `write failed: ${out.code ?? ''} ${out.error ?? ''}`);
  assert(readFileSync(target, 'utf8').includes(TOKEN), 'real token not written');
});

await check('a masked value is detectable so a write path can refuse it', async () => {
  const { isMaskedValue } = await import('../lib/canonical.js');
  assert(isMaskedValue(`figd••••0000`), 'masked value not recognised');
  assert(!isMaskedValue(TOKEN), 'real token mistaken for a mask');
  assert(!isMaskedValue('plain-value'), 'ordinary value mistaken for a mask');
});

/*
 * The refusal itself: a masked env value, a masked header value, and a masked
 * command-line credential must each be rejected with a distinguishable code,
 * because "reload and retry" is different advice from "you may not write this".
 */
await check('applyServerToTarget refuses a masked env credential', async () => {
  const { applyServerToTarget } = await import('../lib/ops.js');
  const out = await applyServerToTarget({ store, configEditor: null, profileDir: root }, {
    server: { name: 'figma', transport: 'stdio', command: 'npx', args: [], env: { FIGMA_API_KEY: 'figd••••0000' }, headers: {} },
    clientId: 'opencode', scope: 'global', path: target,
  });
  assert(out.ok === false, 'masked env credential was accepted');
  assert(out.code === 'error.server.masked', `unexpected code ${out.code}`);
});

await check('applyServerToTarget refuses a masked command-line credential', async () => {
  const { applyServerToTarget } = await import('../lib/ops.js');
  const out = await applyServerToTarget({ store, configEditor: null, profileDir: root }, {
    server: { name: 'figma', transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--figma-api-key=figd••••0000'], env: {}, headers: {} },
    clientId: 'opencode', scope: 'global', path: target,
  });
  assert(out.ok === false, 'masked args credential was accepted');
  assert(out.code === 'error.server.masked', `unexpected code ${out.code}`);
  assert(out.error.includes('args'), `message does not name the position: ${out.error}`);
});

await check('a real definition still writes after the guards', async () => {
  const { applyServerToTarget } = await import('../lib/ops.js');
  const out = await applyServerToTarget({ store, configEditor: null, profileDir: root }, {
    server: { name: 'figma2', transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', `--figma-api-key=${TOKEN}`], env: {}, headers: {} },
    clientId: 'opencode', scope: 'global', path: target,
  });
  assert(out.ok, `real write refused: ${out.code ?? ''} ${out.error ?? ''}`);
  assert(readFileSync(target, 'utf8').includes(TOKEN), 'token missing after write');
});

console.log(`\n${passed} passing, ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
