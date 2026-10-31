/**
 * Runtime load status.
 *
 * The whole point of this feature is to say "this server is mounted but never
 * connected" out loud. Two failure modes would make it worse than useless:
 *
 *   - accusing a healthy server, because the tool registry could not be read
 *   - crediting a dead server, because a missing count was treated as zero
 *
 * So the assertions below are mostly about the boundary between `unknown`,
 * `failed` and `loaded`, and about the name matching that decides which tools
 * belong to which server.
 */
import { indexLiveTools, liveToolNames, loadRecord, loadStatus } from '../lib/load.js';

let failed = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
function eq(actual, expected, message) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: ${left} !== ${right}`);
}

console.log('load status');

await check('a server with registered tools is loaded', () => {
  const names = ['mcp__alpha__one', 'mcp__alpha__two'];
  const counts = indexLiveTools(names, ['alpha']);
  eq(loadRecord({ mountName: 'alpha', mounted: true, enabled: true, counts, registry: true }),
    { mountName: 'alpha', status: 'loaded', toolCount: 2, registry: true }, 'alpha');
});

await check('a mounted server with no registered tool is failed', () => {
  const counts = indexLiveTools(['mcp__beta__one'], ['alpha']);
  eq(loadRecord({ mountName: 'alpha', mounted: true, enabled: true, counts, registry: true }),
    { mountName: 'alpha', status: 'failed', toolCount: 0, registry: true }, 'alpha');
});

await check('an unreadable registry reports unknown, never failed', () => {
  eq(loadRecord({ mountName: 'alpha', mounted: true, enabled: true, counts: null, registry: false }),
    { mountName: 'alpha', status: 'unknown', toolCount: 0, registry: false }, 'alpha');
});

await check('a disabled server is off, not failed', () => {
  eq(loadStatus({ mounted: true, enabled: false, pending: false, toolCount: 0 }), 'off', 'off');
});

await check('a patch row the loader has not reconciled is pending', () => {
  eq(loadStatus({ mounted: true, enabled: true, pending: true, toolCount: 0 }), 'pending', 'pending');
});

await check('a server not mounted in the harness is absent', () => {
  eq(loadStatus({ mounted: false, enabled: false, pending: false, toolCount: null }), 'absent', 'absent');
});

await check('tools of a longer server name are not credited to a shorter prefix', () => {
  /* `alpha` is a prefix of `alpha-two`, so a substring match would give alpha 3. */
  const counts = indexLiveTools(['mcp__alpha-two__one', 'mcp__alpha__one'], ['alpha', 'alpha-two']);
  eq(counts.get('alpha'), 1, 'alpha');
  eq(counts.get('alpha-two'), 1, 'alpha-two');
});

await check('a server name containing double underscores is matched whole', () => {
  /* `serverName` allows underscores, so `mcp__a__b__tool` must not credit `a`. */
  const counts = indexLiveTools(['mcp__a__b__tool'], ['a', 'a__b']);
  eq(counts.get('a') ?? 0, 0, 'a');
  eq(counts.get('a__b'), 1, 'a__b');
});

await check('tools from an unrelated server are ignored', () => {
  const counts = indexLiveTools(['mcp__other__tool', 'read_file'], ['alpha']);
  eq(counts.size, 0, 'no server matched');
});

await check('an empty registry reads as no tools rather than as an error', () => {
  eq(liveToolNames({ schemas: () => [] }), [], 'empty list');
});

await check('a missing tools service yields null, not an empty list', () => {
  eq(liveToolNames(undefined), null, 'undefined');
  eq(liveToolNames({}), null, 'no schemas method');
});

await check('a throwing registry is contained instead of blanking the page', () => {
  eq(liveToolNames({ schemas: () => { throw new Error('boom'); } }), null, 'threw');
});

await check('schemas without usable names are dropped', () => {
  eq(liveToolNames({ schemas: () => [{ name: 'ok' }, { nope: 1 }, null] }), ['ok'], 'filtered');
});

await check('the record carries the mount name so the UI can explain it', () => {
  const record = loadRecord({ mountName: 'alpha', mounted: true, enabled: true, counts: new Map(), registry: true });
  eq(record.mountName, 'alpha', 'mountName');
});

await check('a missing mount name still yields a record rather than throwing', () => {
  const record = loadRecord({ mountName: null, mounted: true, enabled: true, counts: new Map(), registry: true });
  eq(record.status, 'failed', 'unmatched mount is failed');
  eq(record.mountName, null, 'mountName stays null');
});

console.log(`\n${passed} passing, ${failed} failing`);
process.exitCode = failed === 0 ? 0 : 1;
