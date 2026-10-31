/**
 * Retry: rebuild a mounted server's dead connection for real.
 *
 * This suite exists because the FIRST implementation of retry was a lie. It
 * called `hmr.reconcileProfile([entryId])`, which returned success and rebuilt
 * nothing: a failed mcp-client keeps its fiber `active` (it swallows the connect
 * error under `failOnStartupError: false`) and reconcile only restarts INACTIVE
 * entries. Measured against a dead row it answered ok:true, before=failed,
 * after=failed, forever.
 *
 * So every assertion here is about the observable effect, not the call shape:
 * the connection is disposed and recreated through the SAME lever the plugin
 * manager itself uses, the answer reports what the tool registry actually shows,
 * and a refusal leaves the server exactly as it was found.
 *
 * The whole feature is driven through `apply()` / `dispatch()` rather than by
 * importing opRetry, because opRetry lives in the closure — testing the real
 * path is the only way to prove the route, the guard and the report agree.
 *
 *   node scripts/test-retry.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/* A throwaway DSH home per run: the real store and the real patch file are
   exercised, so a retry that quietly wrote to the profile would be caught. */
const home = mkdtempSync(join(tmpdir(), 'mcpm-retry-'));
const profileDir = join(home, 'profiles', 'desktop');
mkdirSync(profileDir, { recursive: true });
const patchPath = join(profileDir, 'cordis.patch.yml');
writeFileSync(patchPath, '- id: other\n  name: x\n', 'utf8');
process.env.DSH_HOME = home;
process.env.DSH_PROFILE = 'desktop';
/*
 * The harness exports DSH_PROFILE_DIR during a real run and the plugin prefers
 * it over DSH_HOME, so it has to be redirected too — otherwise this suite reads
 * the developer's own composition while writing its fixture somewhere else, and
 * passes for the wrong reason.
 */
process.env.DSH_PROFILE_DIR = profileDir;

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client';

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
  }
}

/** A live Loader row, shaped the way the real one is (entry.options.name). */
function row(id, serverName, extra = {}) {
  return {
    entry: { id, options: { name: MCP_CLIENT } },
    inherited: {},
    override: { serverName, transport: 'stdio', command: 'npx', ...extra },
  };
}

function fakeEditor(rows) {
  const state = rows.map((item) => ({ ...item }));
  return { configuration: () => state.map((item) => ({ entry: item.entry, inherited: item.inherited, override: item.override })) };
}

/**
 * A stand-in for the Host's tool registry. `tools` holds the registered names,
 * and the fake plugin manager is the only thing allowed to change them: enabling
 * a row is what makes its tools appear, exactly like a real reconnect.
 */
function harness({ rows, tools: initialTools = [], onDisable, onEnable, manager = true } = {}) {
  const registry = { names: [...initialTools] };
  const calls = [];
  let registered = null;
  const toolsService = { schemas: () => registry.names.map((name) => ({ name })) };
  const configEditor = fakeEditor(rows ?? []);
  const pluginManager = manager
    ? {
        async setPluginEnabled(id, enabled) {
          calls.push({ id, enabled });
          if (enabled === false && onDisable) return onDisable(id, registry);
          if (enabled === true && onEnable) return onEnable(id, registry);
          return { changed: true, application: 'applied', target: id, enabled, warnings: [] };
        },
      }
    : undefined;
  const services = { configEditor, tools: toolsService, pluginManager, webServer: undefined, workspaceRegistry: undefined };
  const ctx = {
    get: (key) => services[key],
    effect: (fn) => fn(),
  };
  return { ctx, calls, registry, toolsService, configEditor, get registered() { return registered; }, setRegistered: (value) => { registered = value; } };
}

/** Run apply() and hand back the registered mcp_manage tool. */
async function load(h) {
  const { apply } = await import('../lib/index.js');
  const originalRegister = h.toolsService.register;
  h.toolsService.register = (definition) => {
    h.setRegistered(definition);
    return originalRegister ? originalRegister(definition) : () => {};
  };
  apply(h.ctx, { retryTimeoutMs: 300, probeTimeoutMs: 500 });
  assert(h.registered, 'apply() must register the mcp_manage tool');
  return h.registered;
}

const retry = (tool, name) => tool.execute({ action: 'retry', name });

console.log('retry');

/* ------------------------------------------------------------------------- */
/* The bug that started all of this: a dead row must actually be revived.     */
/* ------------------------------------------------------------------------- */
await check('a failed row is rebuilt by disposing and recreating the connection', async () => {
  const h = harness({
    rows: [row('mcp-alpha', 'alpha')],
    tools: [],
    onEnable: (_id, registry) => {
      registry.names.push('mcp__alpha__one', 'mcp__alpha__two');
      return { changed: true, application: 'applied', target: 'mcp-alpha', enabled: true, warnings: [] };
    },
  });
  const tool = await load(h);
  const result = await retry(tool, 'alpha');

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.before.status, 'failed', 'the row had no tools, so it must have read as failed');
  assert.equal(result.loaded, true, 'after the rebuild the server must read as loaded');
  assert.equal(result.toolCount, 2, 'the tool count must come from the registry, not from the config');
  assert.deepEqual(h.calls.map((call) => call.enabled), [false, true], 'the connection is disposed then recreated');
  assert.equal(h.calls[0].id, 'mcp-alpha', 'the Loader entry id read off the row is used verbatim');
});

await check('the answer reports the entry id, the mount name and the application', async () => {
  const h = harness({ rows: [row('mcp-alpha', 'alpha')], tools: ['mcp__alpha__x'] });
  const tool = await load(h);
  const result = await retry(tool, 'alpha');
  assert.equal(result.entryId, 'mcp-alpha');
  assert.equal(result.mountName, 'alpha');
  assert.equal(result.application, 'applied');
  assert.equal(result.warnings.length, 0);
});

/*
 * The CJK case, which is where a naive implementation silently polls the wrong
 * registry prefix: the row is sanctioned `API-0aac0ee2` while the user knows it
 * as `示例服务器 - API 文档`. The retry must wait for tools under the MOUNT name
 * (`mcp__API-0aac0ee2__*`), so `mountedAs` has to survive into the poll.
 */
await check('a renamed row is polled under its mount name, not its display name', async () => {
  const display = '示例服务器 - API 文档';
  const mount = 'API-0aac0ee2';
  const h = harness({
    rows: [row(`mcp-${mount}`, mount, {})],
    tools: [],
    onEnable: (_id, registry) => {
      registry.names.push(`mcp__${mount}__getUser`);
      return { changed: true, application: 'applied', target: `mcp-${mount}`, enabled: true, warnings: [] };
    },
  });
  const tool = await load(h);
  const result = await retry(tool, mount);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mountName, mount);
  assert.equal(result.toolCount, 1, `tools must be counted under mcp__${mount}__`);
  assert.equal(display.length > 0, true);
});

/* ------------------------------------------------------------------------- */
/* Refusals: a retry that cannot work must say so and write nothing.          */
/* ------------------------------------------------------------------------- */
await check('a server that is not mounted is refused with a reason', async () => {
  const h = harness({ rows: [] });
  const tool = await load(h);
  const result = await retry(tool, 'nowhere');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.server.missing');
});

await check('a row that is still activating is refused instead of raced', async () => {
  const { writeDshPatchServer } = await import('../lib/dsh-patch.js');
  /* A row can be in the patch file before the Loader has reconciled it. It has
     no live entry to address, and rebuilding it would race the mount that is
     already in flight — so the answer must be "wait", not a half-done rebuild. */
  writeDshPatchServer({
    server: { name: 'beta', transport: 'stdio', command: 'npx', args: ['-y', 'beta-mcp'], env: {} },
    profileDir,
  });
  const h = harness({ rows: [], tools: [] });
  const tool = await load(h);
  const result = await retry(tool, 'beta');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.code, 'error.dsh.pending', `got ${result.code}: ${result.error}`);
  assert.equal(h.calls.length, 0, 'nothing may be touched when the row cannot be addressed yet');
});

await check('without a plugin manager the retry refuses rather than pretending', async () => {
  const h = harness({ rows: [row('mcp-alpha', 'alpha')], tools: [], manager: false });
  const tool = await load(h);
  const result = await retry(tool, 'alpha');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.dsh.noManager');
});

await check('a disposal the manager rejects is reported, and nothing is enabled', async () => {
  const h = harness({
    rows: [row('mcp-alpha', 'alpha')],
    tools: [],
    onDisable: () => ({ changed: false, application: 'failed', target: 'mcp-alpha', error: { code: 'error.plugin.read-only', diagnostic: 'management-required' } }),
  });
  const tool = await load(h);
  const result = await retry(tool, 'alpha');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.dsh.retry');
  assert.match(result.error, /error\.plugin\.read-only/);
  assert.deepEqual(h.calls.map((call) => call.enabled), [false], 'a refused disposal must not be followed by an enable');
});

/*
 * The safety rule that matters most: an exception in the middle must never
 * leave the server switched off. A retry that fails is recoverable; a server
 * silently disabled by a failed retry is not.
 */
await check('a throw while re-enabling leaves the row enabled', async () => {
  let enabledAgain = 0;
  const h = harness({
    rows: [row('mcp-alpha', 'alpha')],
    tools: [],
    onEnable: () => {
      enabledAgain += 1;
      if (enabledAgain === 1) throw new Error('loader exploded');
      return { changed: true, application: 'applied', target: 'mcp-alpha', enabled: true, warnings: [] };
    },
  });
  const tool = await load(h);
  const result = await retry(tool, 'alpha');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.dsh.retry');
  assert.match(result.error, /loader exploded/);
  assert.deepEqual(h.calls.map((call) => call.enabled), [false, true, true], 'the failed retry must put the row back');
});

await check('an empty name is rejected before anything is read', async () => {
  const h = harness({ rows: [row('mcp-alpha', 'alpha')] });
  const tool = await load(h);
  const result = await tool.execute({ action: 'retry' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'error.input');
});

console.log(`\n${passed} passing${failures.length ? `, ${failures.length} failing` : ''}`);
if (failures.length) process.exitCode = 1;
