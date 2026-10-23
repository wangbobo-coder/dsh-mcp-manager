/**
 * The mount-name mapping, end to end.
 *
 * The harness's `@deepseek-ai/dsh-mcp-client` accepts only `[A-Za-z0-9_-]{1,32}`
 * as `serverName`, so a name like `示例服务器 - API 文档` has to be mapped before
 * it can be mounted. That mapping is where two visible bugs lived:
 *
 *   - `sanitizeName` alone collapsed EVERY CJK name to `API` (the only ASCII
 *     fragment they shared), so three different servers tried to mount under one
 *     name. The page then looked the mount up by the DISPLAY name, found nothing,
 *     and drew the switch as off for a server that was mounted.
 *   - `waitForRow` waited for a row named after the display name, never saw it,
 *     and told the user to restart for a row that was already live.
 *
 * These checks pin the mapping itself plus the scan-side fold that puts a mounted
 * row back under its display name.
 */
import assert from 'node:assert/strict';
import { dshMountName, sanitizeName } from '../lib/canonical.js';
import { scanAll } from '../lib/scan.js';

let passing = 0;
let failing = 0;
async function check(name, fn) {
  try {
    await fn();
    passing += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failing += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error && error.message ? error.message : error}`);
  }
}

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

console.log('the mapping');

await check('an already-valid name is returned untouched', () => {
  assert.equal(dshMountName('context7'), 'context7');
  assert.equal(dshMountName('playwright_mcp'), 'playwright_mcp');
});

await check('an ascii name keeps the readable sanitized form', () => {
  assert.equal(dshMountName('My Bridge'), 'My-Bridge');
  assert.equal(dshMountName('my server!'), 'my-server');
});

await check('three CJK names that sanitizeName collapses get distinct mount names', () => {
  const display = ['示例服务器 - API 文档', '示例助手 - API 文档', '另一个服务 - API 文档'];
  /* Pin the bug being fixed: the OLD mapping sent all three to the same name. */
  assert.equal(new Set(display.map((name) => sanitizeName(name))).size, 1, 'precondition: sanitizeName collides here');
  const mounts = display.map((name) => dshMountName(name));
  assert.equal(new Set(mounts).size, 3, `mount names must be distinct, got ${JSON.stringify(mounts)}`);
});

await check('every mount name satisfies the harness schema', () => {
  const inputs = ['示例服务器 - API 文档', '完全中文名', 'a'.repeat(60), 'my server!', '', 'emoji 🚀 server', 'context7'];
  for (const input of inputs) {
    const mount = dshMountName(input);
    assert(SERVER_NAME_RE.test(mount), `${JSON.stringify(input)} -> ${JSON.stringify(mount)} is not a legal serverName`);
  }
});

await check('the mapping is deterministic, so a repeat apply updates instead of duplicating', () => {
  assert.equal(dshMountName('示例服务器 - API 文档'), dshMountName('示例服务器 - API 文档'));
});

await check('a fully-CJK name does not fall back to the constant "server"', () => {
  const mount = dshMountName('完全中文名');
  assert.notEqual(mount, 'server');
  assert(/^[A-Za-z0-9_-]+$/.test(mount));
});

console.log('the scan fold');

const CJK = '示例服务器 - API 文档';

/**
 * A store that serves one Qoder config declaring `CJK`.
 *
 * The display name has to come from somewhere: the harness row carries only the
 * mapped mount name, so the fold can only work when another client still declares
 * the server under its display name (or the ledger remembers it). That is the real
 * shape — `CJK` lives in Qoder's mcp.json and we mount it.
 */
function storeServing(displayName) {
  return {
    readFile: (path) => {
      if (/Qoder/i.test(path)) {
        return { ok: true, exists: true, text: JSON.stringify({ mcpServers: { [displayName]: { command: 'cmd', args: ['/c', 'npx'] } } }), hash: 'h1', mtimeMs: 1 };
      }
      return { ok: true, exists: false, text: '', hash: null, mtimeMs: 0 };
    },
    allOwnership: () => ({}),
  };
}

/** A configEditor stand-in exposing one mcp-client row, shaped like the live Loader. */
function editorWith(rows) {
  return {
    configuration: () => rows.map((row) => ({ entry: { id: row.id, options: { name: '@deepseek-ai/dsh-mcp-client' } }, inherited: row.config, override: {} })),
    edit: async () => {},
  };
}

function mountRow(displayName) {
  return { id: `mcp-${dshMountName(displayName)}`, config: { serverName: dshMountName(displayName), transport: 'stdio', command: 'cmd', args: ['/c', 'npx'] } };
}

await check('a CJK server mounted under its mapped name appears under its display name', () => {
  const state = scanAll({ store: storeServing(CJK), configEditor: editorWith([mountRow(CJK)]), projectRoots: [], reveal: false, profileDir: 'C:/nonexistent' });
  const node = state.servers.find((item) => item.name === CJK);
  assert(node, `expected a node named after the display name, got ${JSON.stringify(state.servers.map((item) => item.name))}`);
  const dsh = node.targets.find((target) => target.clientId === 'dsh');
  assert(dsh, 'the display-named node must carry the dsh target');
  assert.equal(dsh.mountedAs, dshMountName(CJK), 'the mount name must stay visible on the target');
  /* The switch reads this: one node, both declaring files, mounted once. */
  assert.equal(node.clients.length, 2, `expected qoder + dsh, got ${JSON.stringify(node.clients)}`);
});

await check('no phantom node is left under the mapped name', () => {
  const state = scanAll({ store: storeServing(CJK), configEditor: editorWith([mountRow(CJK)]), projectRoots: [], reveal: false, profileDir: 'C:/nonexistent' });
  const phantom = state.servers.find((item) => item.name === dshMountName(CJK));
  assert.equal(phantom, undefined, 'the raw mount name must not survive as its own server');
});

await check('the dsh source card lists the display name and remembers the mount name', () => {
  const state = scanAll({ store: storeServing(CJK), configEditor: editorWith([mountRow(CJK)]), projectRoots: [], reveal: false, profileDir: 'C:/nonexistent' });
  const source = state.sources.find((item) => item.clientId === 'dsh');
  assert(source, 'the dsh source must exist');
  const item = source.servers.find((server) => server.name === CJK);
  assert(item, `expected the display name in the source card, got ${JSON.stringify(source.servers.map((server) => server.name))}`);
  assert.equal(item.mountName, dshMountName(CJK));
});

await check('a mapped fold does not appear when only the harness declares the server', () => {
  /* No other client knows the display name and the ledger is empty, so the row
     must keep the name it was written with rather than inventing one. */
  const state = scanAll({ store: storeServing('something-else'), configEditor: editorWith([mountRow(CJK)]), projectRoots: [], reveal: false, profileDir: 'C:/nonexistent' });
  const node = state.servers.find((item) => item.name === dshMountName(CJK));
  assert(node, 'the lone harness row keeps its mount name');
});

await check('the ledger display name folds a mount whose client config is gone', () => {
  const store = {
    readFile: () => ({ ok: true, exists: false, text: '', hash: null, mtimeMs: 0 }),
    allOwnership: () => ({
      [dshMountName(CJK)]: { targets: { 'dsh:profile:(profile composition)': { displayName: CJK } } },
    }),
  };
  const state = scanAll({ store, configEditor: editorWith([mountRow(CJK)]), projectRoots: [], reveal: false, profileDir: 'C:/nonexistent' });
  const node = state.servers.find((item) => item.name === CJK);
  assert(node, `expected the ledger to restore the display name, got ${JSON.stringify(state.servers.map((item) => item.name))}`);
});

await check('an ascii mount name is folded back too, so the switch state is the same everywhere', () => {
  const display = 'My Bridge';
  const state = scanAll({ store: storeServing(display), configEditor: editorWith([mountRow(display)]), projectRoots: [], reveal: false, profileDir: 'C:/nonexistent' });
  assert.equal(dshMountName(display), 'My-Bridge', 'the ascii name keeps its readable form');
  const node = state.servers.find((item) => item.name === display);
  assert(node, `expected the display name, got ${JSON.stringify(state.servers.map((item) => item.name))}`);
  assert(node.targets.some((target) => target.clientId === 'dsh'), 'its switch state must be the mounted one');
});

console.log(`\n${passing} passing, ${failing} failing`);
process.exit(failing === 0 ? 0 : 1);
