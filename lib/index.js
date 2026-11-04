/**
 * Host side of the MCP manager.
 *
 * Responsibilities:
 *   1. serve the matrix, diff, probe, history and mutation routes the settings
 *      page calls;
 *   2. expose the same operations to the agent as a `mcp_manage` tool, so the
 *      page and the agent cannot diverge (one implementation, two callers);
 *   3. keep every write guarded, backed up, and recorded in the ledger.
 *
 * The plugin is dormant rather than broken in profiles without `webServer` or
 * `tools`: those are optional injection points, and the scan still works with
 * nothing but a filesystem.
 */

import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { createStore } from './store.js';
import { scanAll } from './scan.js';
import { probeMany, probeServer } from './probe.js';
import { addServers, applyServerToTarget, removeServer, syncServer, snippetFor } from './ops.js';
import { CLIENTS, CLIENT_BY_ID } from './adapters.js';
import { redactServer, isSecretKey, isSecretValue, maskValue, dshMountName } from './canonical.js';
import { toggleServer } from './toggle.js';
import { countLiveTools, liveToolNames, loadRecord } from './load.js';
import { mcpEntries } from './dsh.js';

export const name = 'mcp-manager';

export const inject = ['webServer', 'tools', 'configEditor', 'workspaceRegistry'];

const ROUTE = '/api/dsh-mcp-manager';

function json(res, status, payload) {
  if (!res || res.writableEnded) return;
  const body = JSON.stringify(payload ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function errorJson(res, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  json(res, status, {
    ok: false,
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    error: String(error?.message ?? error),
    ...(error?.hint ? { hint: error.hint } : {}),
    ...(error?.conflict ? { conflict: error.conflict } : {}),
  });
}

/**
 * Map an operation's failure code onto the HTTP status it deserves.
 *
 * Everything used to be a 400, which hid the one case a caller must handle
 * differently: a compare-and-set conflict means "someone else changed the file
 * since you read it" — that is a 409, and the UI offers a re-scan on it rather
 * than showing a validation error. Unknown code/action stay 400; an unreadable
 * or unwritable file is a 500-class server-side condition.
 */
const STATUS_BY_CODE = new Map([
  ['error.file.conflict', 409],
  ['error.file.read', 500],
  ['error.file.write', 500],
  ['error.file.parse', 422],
  ['error.write.render', 422],
  ['error.target.readOnly', 403],
  ['error.target.transport', 422],
  ['error.secret.projectScope', 422],
  ['error.backup.missing', 404],
  ['error.route.missing', 404],
  ['error.action.unknown', 400],
  ['error.dsh.notMounted', 409],
  ['error.dsh.pending', 409],
  ['error.dsh.noEntry', 409],
  ['error.dsh.noHmr', 501],
  ['error.dsh.retry', 500],
]);

function statusFor(result) {
  if (result && typeof result.code === 'string') {
    return STATUS_BY_CODE.get(result.code) ?? 400;
  }
  return 400;
}

/** Reject cross-origin and non-JSON mutations, matching host server policy. */
function validateOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return 'forbidden host';
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'forbidden cross-site request';
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      if (new URL(origin).host !== host) return 'forbidden origin';
    } catch {
      return 'forbidden origin';
    }
  }
  return null;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('body must be JSON'), { statusCode: 400, code: 'error.proto.json' });
  }
}

/**
 * Strip what JSON cannot carry losslessly before a result becomes a tool answer.
 *
 * The canonical model omits fields as `undefined` (`url` on a stdio server,
 * `timeoutMs` when unset, `cwd` when absent) because that keeps the internal
 * comparisons simple, and a scan snapshot therefore carries hundreds of them.
 * The HTTP route never notices — `JSON.stringify` drops such keys — but a tool
 * result is validated as LOSSLESS JSON before the model sees it, so returning a
 * raw snapshot made the whole `mcp_manage` tool fail with "value is not lossless
 * JSON" instead of answering. That also broke `scan`, not just the new `add`.
 *
 * Dropping `undefined` object keys, replacing non-finite numbers with `null` and
 * turning `Date`s into ISO strings is what a JSON round trip does, except this
 * also fixes ARRAYS, where a JSON round trip would silently turn a hole into
 * `null` and lose the "absent" meaning. Cycles degrade to a marker rather than
 * throwing: a scan snapshot must never fail to render because of one `raw` entry.
 */
function toLosslessJson(value, seen = new WeakSet(), depth = 0) {
  if (depth > 24) return null;
  if (value === null) return null;
  if (value === undefined) return undefined;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') return Number.isFinite(value) ? value : null;
  if (kind === 'bigint') return String(value);
  if (kind === 'function' || kind === 'symbol') return undefined;
  if (kind !== 'object') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) {
        const next = toLosslessJson(item, seen, depth + 1);
        out.push(next === undefined ? null : next);
      }
      return out;
    }
    if (value instanceof Map) {
      return toLosslessJson(Object.fromEntries(value), seen, depth + 1);
    }
    if (value instanceof Set) {
      return toLosslessJson([...value], seen, depth + 1);
    }
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      const next = toLosslessJson(inner, seen, depth + 1);
      if (next !== undefined) out[key] = next;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function registeredWorkspaceRoots(ctx) {
  const out = new Set();
  try {
    const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
    if (registry && typeof registry.list === 'function') {
      for (const item of registry.list()) {
        const path = item?.path ?? item?.cwd;
        if (typeof path === 'string' && path.trim()) out.add(path.trim());
      }
    }
  } catch { /* workspace registry is optional */ }
  return [...out];
}

/**
 * Which profile's composition is this process serving?
 *
 * `profileContext` is the running Host's own answer and therefore the first
 * source consulted: `boot()` provides `{ name, dir, … }` before any profile
 * plugin loads, so it survives every launch shape — including the Desktop app,
 * which exports no `DSH_PROFILE_DIR` into its own process (`dsh-shell-env` only
 * injects that variable into *shell tool* executions, never into the Host).
 *
 * The environment is the second choice, kept for hosts that do export it. The
 * old `'desktop'` fallback was removed because it wrote patch rows into
 * `~/.dsh/profiles/desktop/` — a directory it created, belonging to a profile
 * that never runs — so every added server showed "activating" forever while
 * nothing ever mounted. The rows were real, just invisible to the Loader.
 *
 * So ask the context, then `DSH_PROFILE_DIR`, then the flag the process was
 * started with, then the profile name variable, and only then fall back to "the
 * machine has exactly one profile". When nothing identifies one this returns
 * undefined and the write path refuses with `error.dsh.noProfile`: an honest
 * failure beats configuring a profile that does not exist.
 */
export function resolveProfileDir({ home, argv = process.argv, env = process.env, profile } = {}) {
  const fromContext = profile && typeof profile.dir === 'string' ? profile.dir.trim() : '';
  if (fromContext) return fromContext;
  const contextName = profile && typeof profile.name === 'string' ? profile.name.trim() : '';
  if (contextName) return join(home, 'profiles', contextName);

  const explicit = env.DSH_PROFILE_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (typeof arg !== 'string') continue;
    if (arg === '--profile') {
      const next = args[index + 1];
      if (typeof next === 'string' && next.trim() && !next.startsWith('-')) return join(home, 'profiles', next.trim());
    }
    if (arg.startsWith('--profile=')) {
      const name = arg.slice('--profile='.length).trim();
      if (name) return join(home, 'profiles', name);
    }
  }

  const named = env.DSH_PROFILE;
  if (typeof named === 'string' && named.trim()) return join(home, 'profiles', named.trim());

  try {
    const dir = join(home, 'profiles');
    const profiles = readdirSync(dir, { withFileTypes: true })
      .filter((item) => item.isDirectory() && existsSync(join(dir, item.name, 'cordis.yml')))
      .map((item) => item.name);
    if (profiles.length === 1) return join(dir, profiles[0]);
  } catch { /* no profiles directory at all: nothing identifies a profile */ }
  return undefined;
}

export function apply(ctx, config = {}) {
  const options = {
    probeTimeoutMs: Number.isFinite(config.probeTimeoutMs) ? config.probeTimeoutMs : 20000,
    backupsToKeep: Number.isFinite(config.backupsToKeep) ? config.backupsToKeep : 20,
    includeProjectScope: config.includeProjectScope !== false,
    probeConcurrency: Number.isFinite(config.probeConcurrency) ? config.probeConcurrency : 4,
    retryTimeoutMs: Number.isFinite(config.retryTimeoutMs) ? config.retryTimeoutMs : 25000,
  };

  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const store = createStore({ root: join(home, 'mcp-manager'), backupsToKeep: options.backupsToKeep });
  store.ensureDirs();

  /*
   * The patch layer lives in the profile directory. The Host knows that
   * directory as `profileContext.dir`; the environment only carries it for
   * shell tools, which is why a Desktop-launched Host used to fail here. Read
   * the context first and keep the flag/env fallbacks for hosts that have no
   * such service (see `resolveProfileDir`).
   */
  const profileContext = () => (typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined);
  const profileDir = resolveProfileDir({ home, profile: profileContext() });

  const configEditor = () => (typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined);

  /* The tool registry is the only truthful source of "did the connection
     succeed": a connected server has registered `mcp__<mount>__<tool>` names,
     while `@deepseek-ai/dsh-mcp-client` swallows a failed connect. Read lazily
     so a profile without the service still scans (statuses become `unknown`). */
  const toolRegistry = () => (typeof ctx.get === 'function' ? ctx.get('tools') : undefined);

  const projectRoots = () => (options.includeProjectScope ? registeredWorkspaceRoots(ctx) : []);

  const snapshot = (reveal = false) =>
    scanAll({ store, configEditor: configEditor(), projectRoots: projectRoots(), reveal, profileDir, tools: toolRegistry() });

  /* ---------------------------------------------------------- operations -- */

  async function opScan({ reveal = false } = {}) {
    const state = snapshot(reveal);
    return {
      ...state,
      clients: state.clients.map((client) => ({ ...client, canWrite: !client.readOnly || client.managed })),
      history: store.recentWrites(20),
      backups: store.listBackups(20),
    };
  }

  /**
   * The switch: mount or unmount one server in DeepSeek Harness.
   *
   * A server that only exists in another tool is not "off" in any file — it is
   * simply not mounted here. Turning it on therefore mounts it (via the patch
   * layer, which is how a new mcp-client row gets created), and turning it off
   * after that unmounts it. Nothing in the originating tool is ever written.
   */
  async function opToggle(body) {
    const name = body.name;
    if (!name) return { ok: false, code: 'error.input', error: 'name is required' };
    if (typeof body.enabled !== 'boolean') return { ok: false, code: 'error.input', error: 'enabled must be a boolean' };
    const state = snapshot(true);
    const node = state.servers.find((item) => item.name === name);
    const mounted = node?.targets.find((target) => target.clientId === 'dsh');
    /*
     * The composition keys the row by mount name; a CJK or spaced display name
     * is mapped (see `dshMountName`). Use the name the scan actually read off
     * the row when it knows it, and derive the same mapping otherwise, so the
     * row we address, the row we wait for and the row the scan reports are one
     * and the same.
     */
    const mountName = mounted?.mountedAs ?? mounted?.server?.mountName ?? dshMountName(name);
    if (mounted) {
      const result = await toggleServer({ get: (key) => ctx.get(key), profileDir, store }, { name, mountName, enabled: body.enabled, entryId: mounted.entryId ?? node.canonical?.entryId });
      /*
       * A patch-layer flip (an override item added or removed) is picked up by the
       * Loader on its own, so give it the same chance to reconcile. As above, a
       * timeout means "still activating", not "restart required".
       */
      if (result.ok && result.via === 'patch' && body.enabled === true) {
        const reconciled = await waitForRow(mountName, 8000);
        return { ...result, name, mountName, live: reconciled !== null, activating: reconciled === null, restartRequired: false, state: snapshot(body.reveal === true) };
      }
      return { ...result, name, state: snapshot(body.reveal === true) };
    }
    if (body.enabled !== true) {
      return { ok: true, changed: false, enabled: false, name, notMounted: true, state: snapshot(body.reveal === true) };
    }
    if (!node) return { ok: false, code: 'error.server.missing', error: `unknown server ${name}` };
    const applied = await applyServerToTarget({ store, configEditor: configEditor(), profileDir }, { clientId: 'dsh', scope: 'profile', server: node.canonical, force: body.force === true });
    if (!applied.ok) return { ...applied, name, enabled: true };
    /*
     * A row written into the profile patch layer is picked up by the Loader on
     * its own — no restart. Wait for it so the answer reflects what actually
     * happened instead of telling the user to restart a service that already has
     * the server.
     *
     * Measured on this machine a row usually reconciles in 2-4s, but mounting
     * several back to back (each one reloading the composition and doing an MCP
     * handshake) can push past any fixed budget. Bumping the timeout alone did
     * not fix it, so the timeout is no longer allowed to decide the ANSWER:
     *
     *   reconciled inside the window -> live: true
     *   not yet                       -> activating: true  (never "restart")
     *
     * A patch row is only ever written when the Loader can see it, so it always
     * arrives eventually; claiming a restart is needed was simply wrong and sent
     * the user to restart for nothing. `restartRequired` is kept for the caller
     * contract but is now false on this path.
     */
    const reconciled = applied.via === 'patch' ? await waitForRow(mountName, 8000) : null;
    return {
      ...applied,
      name,
      mountName,
      enabled: true,
      via: applied.via ?? 'patch',
      live: reconciled !== null,
      activating: applied.via === 'patch' && reconciled === null,
      restartRequired: false,
      state: snapshot(body.reveal === true),
    };
  }

  /**
   * Poll the composition until the Loader has reconciled a row we just wrote.
   * Returns the entryId, or null when it never showed up inside the budget — in
   * which case the caller reports it as pending rather than claiming it is live.
   */
  async function waitForRow(name, budgetMs) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const row = mcpEntries(configEditor()).find((item) => {
        const config = { ...item.inherited, ...item.override };
        return (config.serverName ?? item.entry?.id) === name;
      });
      if (row) return row.entry?.id ?? true;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  /**
   * Wait until a reconnected server has registered at least one tool.
   *
   * Polls the tool registry rather than the composition: a rebuilt fiber shows up
   * in the composition immediately, but the connection is only proven by the
   * `mcp__<mount>__*` names it registers. Returns the tool count it last saw, so
   * a 0 after the budget expires is a measured failure, not a guess.
   */
  async function waitForTools(mountName, budgetMs) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const names = liveToolNames(toolRegistry());
      const count = names ? countLiveTools(names, mountName) : 0;
      if (count > 0) return count;
      if (Date.now() >= deadline) return count;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async function opProbe({ names, timeoutMs } = {}) {
    const state = snapshot(true);
    const wanted = Array.isArray(names) && names.length ? new Set(names) : null;
    const queue = state.servers
      .filter((server) => !wanted || wanted.has(server.name))
      .map((server) => ({ key: server.name, server: server.canonical }));
    const results = await probeMany(queue, { timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : options.probeTimeoutMs, concurrency: options.probeConcurrency });
    return {
      results: Object.fromEntries([...results].map(([key, value]) => [key, {
        ...value,
        tools: (value.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description })),
      }])),
      probedAt: new Date().toISOString(),
    };
  }

  async function opApply(body) {
    /*
     * Resolve the definition from the host-side scan (revealed), never from the
     * request body: what the browser holds is the redacted copy, so writing
     * `body.server` back would persist `abcd••••wxyz` over a real credential.
     * The body is only consulted for servers the scan does not know about.
     */
    const state = snapshot(true);
    const known = state.servers.find((item) => item.name === (body.name ?? body.server?.name));
    const server = known?.canonical ?? body.server;
    if (!server) return { ok: false, code: 'error.server.missing', error: `unknown server ${body.name}` };
    const target = body.target ?? {};
    const expectedHash = body.expectedHash ?? state.locations.find((item) => item.clientId === target.clientId && item.scope === target.scope && item.path === target.path)?.hash ?? undefined;
    return applyServerToTarget({ store, configEditor: configEditor(), profileDir }, { ...target, server, expectedHash, force: body.force === true, reuseName: body.reuseName !== false });
  }

  async function opRemove(body) {
    const state = snapshot(true);
    const expectedHash = body.expectedHash ?? state.locations.find((item) => item.clientId === body.clientId && item.scope === body.scope)?.hash ?? undefined;
    return removeServer({ store, configEditor: configEditor(), profileDir }, { ...body, expectedHash });
  }

  /**
   * Create servers from a configuration pasted into the page.
   *
   * This is the one mutation that does not read its definition out of the scan:
   * there is nothing on disk yet. So, unlike apply/sync, the body IS the source
   * of truth — one or more Trae/Cursor-style JSON entries, decoded through the
   * TARGET's dialect before any file or patch is touched. Everything after
   * validation is the ordinary guarded write, one entry at a time.
   */
  async function opAdd(body = {}) {
    const target = body.target ?? { clientId: body.clientId, scope: body.scope, path: body.path };
    if (!target || !target.clientId) return { ok: false, code: 'error.input.target', error: 'clientId is required' };
    const state = snapshot(true);
    const expectedHash = body.expectedHash
      ?? state.locations.find((item) => item.clientId === target.clientId
        && (target.scope === undefined || item.scope === target.scope)
        && (target.path === undefined || item.path === target.path))?.hash
      ?? undefined;
    const deps = { store, configEditor: configEditor(), profileDir };
    /*
     * `projectRoots` travels with the target: a project-scope target has no
     * absolute path until a workspace root is joined to it, and `locateTarget`
     * must resolve the same file the scan read.
     */
    const result = await addServers(deps, {
      config: body.config,
      server: body.server,
      target,
      projectRoots: projectRoots(),
      expectedHash,
      force: body.force === true,
    });
    if (!result.ok) return result;
    const added = (result.results ?? []).filter((item) => item.ok);
    /*
     * DSH rows written through the patch layer only become live once the Loader
     * reconciles them, so wait for every added row exactly like the mount switch
     * does and report "activating" rather than a restart.
     */
    let live = null;
    if (result.clientId === 'dsh' && added.some((item) => item.via === 'patch')) {
      live = true;
      for (const item of added) {
        const reconciled = await waitForRow(item.name, 8000);
        if (reconciled === null) live = false;
      }
    }
    return {
      ...result,
      names: added.map((item) => item.name),
      ...(live === null ? {} : { live, activating: live === false, restartRequired: false }),
      state: snapshot(body.reveal === true),
    };
  }

  async function opSync(body) {
    /* Same rule as opApply: the host holds the real definition, the client does not. */
    const state = snapshot(true);
    const known = state.servers.find((item) => item.name === (body.name ?? body.server?.name));
    const server = known?.canonical ?? body.server;
    if (!server) return { ok: false, code: 'error.server.missing', error: `unknown server ${body.name}` };
    const expectedHashes = Object.fromEntries(state.locations.map((item) => [`${item.clientId}:${item.scope}:${item.path}`, item.hash]));
    return syncServer({ store, configEditor: configEditor(), profileDir }, { server, targets: body.targets ?? [], expectedHashes, force: body.force === true });
  }

  async function opSnippet(body) {
    const state = snapshot(true);
    const known = state.servers.find((item) => item.name === (body.name ?? body.server?.name));
    const server = known?.canonical ?? body.server;
    if (!server) return { ok: false, code: 'error.server.missing', error: `unknown server ${body.name}` };
    return { ok: true, yaml: snippetFor(server) };
  }

  async function opReveal(body) {
    const state = snapshot(false);
    const server = state.servers.find((item) => item.name === body.name);
    if (!server) return { ok: false, code: 'error.server.missing', error: `unknown server ${body.name}` };
    return { ok: true, server: redactServer(server.canonical, true) };
  }

  function opRestore(body) {
    if (!body.backup || !body.path) return { ok: false, code: 'error.input', error: 'backup and path are required' };
    return store.restore(body.backup, body.path);
  }

  /**
   * Retry a mounted server that never connected.
   *
   * Nothing in the config is wrong when a connection fails — the process was
   * simply not there yet (wrong Node version, a package that had not finished
   * downloading, a laptop that had just woken up). The mcp-client keeps its own
   * backoff timer for that, but once it gives up it registers nothing and waits
   * for a reload that a settings page has no way to deliver.
   *
   * `hmr.reconcileProfile` looks like the right lever and is NOT. It recomposes
   * the profile and re-imports the entry, but a failed mcp-client keeps its fiber
   * `active` (it swallows the connect error under `failOnStartupError: false`),
   * and reconcile only restarts entries that are INACTIVE. Measured against a
   * dead row it returned success and rebuilt nothing — a retry button that lies.
   *
   * The lever that does rebuild the connection is the one the plugin manager
   * itself uses: `setPluginEnabled(id, false)` disposes the mcp-client fiber and
   * `setPluginEnabled(id, true)` recreates it, running `apply()` again — a fresh
   * connection attempt. This does exactly that, then polls the tool registry
   * (the only truthful proof of a successful connect) until tools appear or the
   * budget runs out, so the answer is measured rather than assumed.
   *
   * Failure safety: the row is enabled again even when the enable call throws,
   * because leaving a server switched off would be a worse outcome than a retry
   * that did not help.
   */
  async function opRetry(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, code: 'error.input', error: 'name is required' };

    const state = snapshot(false);
    const node = state.servers.find((item) => item.name === name);
    if (!node) return { ok: false, code: 'error.server.missing', error: `unknown server ${name}` };
    const target = node.targets.find((item) => item.clientId === 'dsh');
    if (!target) return { ok: false, code: 'error.dsh.notMounted', error: `${name} is not mounted in DeepSeek Harness` };
    if (target.pending === true) return { ok: false, code: 'error.dsh.pending', error: `${name} is still being mounted; wait for it to appear first` };
    if (!target.entryId) return { ok: false, code: 'error.dsh.noEntry', error: `${name} has no Loader entry id; reload the plugin instead` };

    const manager = typeof ctx.get === 'function' ? ctx.get('pluginManager') : undefined;
    if (!manager || typeof manager.setPluginEnabled !== 'function') {
      return { ok: false, code: 'error.dsh.noManager', error: 'the plugin manager is not available, so the connection cannot be rebuilt' };
    }

    const entryId = target.entryId;
    const mountName = target.mountedAs ?? target.server?.mountName ?? dshMountName(name);
    const before = node.load ?? null;
    const warnings = [];
    let disabled = false;
    let enabled = null;

    try {
      const off = await manager.setPluginEnabled(entryId, false);
      for (const warning of off?.warnings ?? []) warnings.push(warning);
      if (off?.application === 'failed') {
        return {
          ok: false,
          code: 'error.dsh.retry',
          error: `could not dispose the stale connection: ${off?.error?.code ?? 'unknown'}${off?.error?.diagnostic ? ` — ${off.error.diagnostic}` : ''}`,
          before,
          state: snapshot(false),
        };
      }
      disabled = true;
      enabled = await manager.setPluginEnabled(entryId, true);
      for (const warning of enabled?.warnings ?? []) warnings.push(warning);
    } catch (error) {
      /* Put the row back the way the user left it before reporting the failure. */
      if (disabled) {
        try {
          enabled = await manager.setPluginEnabled(entryId, true);
        } catch { /* the retry error below is the one worth reporting */ }
      }
      return {
        ok: false,
        code: 'error.dsh.retry',
        error: String(error && error.message ? error.message : error),
        before,
        state: snapshot(false),
      };
    }

    const toolCount = await waitForTools(mountName, options.retryTimeoutMs);
    const after = snapshot(false).servers.find((item) => item.name === name);
    const load = after?.load ?? loadRecord({ mountName, mounted: true, enabled: true, pending: false, counts: null, registry: false });

    return {
      ok: true,
      name,
      entryId,
      mountName,
      before,
      load,
      loaded: load?.status === 'loaded',
      toolCount,
      warnings,
      application: enabled?.application ?? null,
      restartReason: enabled?.restartReason ?? null,
      state: snapshot(false),
    };
  }

  const dispatch = async (action, body = {}) => {
    switch (action) {
      case 'scan': return opScan(body);
      case 'probe': return opProbe(body);
      case 'apply': return opApply(body);
      case 'add': return opAdd(body);
      case 'remove': return opRemove(body);
      case 'sync': return opSync(body);
      case 'snippet': return opSnippet(body);
      case 'reveal': return opReveal(body);
      case 'toggle': return opToggle(body);
      case 'restore': return opRestore(body);
      case 'retry': return opRetry(body);
      case 'history': return { ok: true, writes: store.recentWrites(100), backups: store.listBackups(100) };
      default: return { ok: false, code: 'error.action.unknown', error: `unknown action ${action}` };
    }
  };

  /* --------------------------------------------------------------- routes -- */

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        try {
          const originError = validateOrigin(req);
          if (originError) { json(res, 403, { ok: false, code: 'error.proto.forbidden', error: originError }); return; }
          const url = new URL(req.url ?? '/', 'http://localhost');
          const path = url.pathname.replace(/\/+$/, '');
          if (req.method === 'GET' || req.method === 'HEAD') {
            if (path === `${ROUTE}/state`) {
              const state = await opScan({ reveal: url.searchParams.get('reveal') === '1' });
              json(res, 200, { ok: true, data: state });
              return;
            }
            if (path === `${ROUTE}/clients`) {
              json(res, 200, { ok: true, data: { clients: CLIENTS } });
              return;
            }
            if (path === `${ROUTE}/history`) {
              json(res, 200, { ok: true, data: { writes: store.recentWrites(100), backups: store.listBackups(100) } });
              return;
            }
            json(res, 404, { ok: false, code: 'error.route.missing', error: `no route ${path}` });
            return;
          }
          if (req.method !== 'POST') { json(res, 405, { ok: false, code: 'error.method', error: 'method not allowed' }); return; }
          const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (contentType !== 'application/json') { json(res, 415, { ok: false, code: 'error.proto.contentType', error: 'content-type must be application/json' }); return; }
          /*
           * A custom header cannot be set by a cross-site form or a plain
           * <script>/<img> request, so requiring it (on top of the JSON
           * content-type and the origin check) is what makes a mutation
           * unreachable without our own page or an explicit caller. Checked
           * before the body is read so a refusal costs nothing.
           */
          if (String(req.headers['x-dsh-mcp-manager'] ?? '') !== '1') {
            json(res, 403, { ok: false, code: 'error.proto.guard', error: 'missing x-dsh-mcp-manager: 1 header' });
            return;
          }
          const body = await readBody(req);
          const action = path.startsWith(`${ROUTE}/`) ? path.slice(ROUTE.length + 1) : '';
          const result = await dispatch(action, body);
          const failed = result && result.ok === false;
          json(res, failed ? statusFor(result) : 200, failed ? result : { ok: true, data: result });
        } catch (error) {
          errorJson(res, error);
        }
      },
    }), 'mcp-manager routes');
  }

  /* ----------------------------------------------------------------- tool -- */

  const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register({
      name: 'mcp_manage',
      description: [
        'Inspect and manage Model Context Protocol servers across the local AI development tools installed on this machine',
        '(DeepSeek Harness, Claude Code, Cursor, VS Code, Roo Code, OpenCode, Trae, Trae CN, Qoder, Gemini CLI, Zed and others).',
        'Use action "scan" to see every server, which tools it is configured in, and whether it actually LOADED in DeepSeek Harness (a mounted row can still be a dead connection),',
        '"probe" to check whether a server actually starts and lists tools, "retry" to re-run the connection of a mounted server that failed to load,',
        '"toggle" to mount or unmount one server in DeepSeek Harness only (it never edits another tool\'s own config file),',
        '"sync" to copy one definition to other tools, "apply" to write one definition to one target, "remove" to delete one, and "snippet" to get a YAML row for adding a brand-new DeepSeek Harness server.',
        '"add" creates brand-new servers from a pasted JSON configuration — the Trae/Cursor shape { "mcpServers": { "<name>": { "command": …, "args": […] } } }, or a bare name→entry map, a single entry with "name", or the servers/mcp/context_servers wrapper — and writes every entry into one target in that target\'s own configuration format. Use it when the server is not declared anywhere yet.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['scan', 'probe', 'apply', 'add', 'remove', 'sync', 'snippet', 'toggle', 'reveal', 'retry', 'history'], description: 'Operation to perform.' },
          name: { type: 'string', description: 'Server name, as reported by scan.' },
          enabled: { type: 'boolean', description: 'For toggle: true mounts the server in DeepSeek Harness, false unmounts it.' },
          clientId: { type: 'string', description: 'Target client id (see scan output).' },
          scope: { type: 'string', enum: ['global', 'project', 'profile'], description: 'Target scope. Defaults to global.' },
          path: { type: 'string', description: 'Explicit target file path, overriding the client/scope resolution.' },
          clientIds: { type: 'array', items: { type: 'string' }, description: 'For sync: client ids to copy the definition into.' },
          names: { type: 'array', items: { type: 'string' }, description: 'For probe: server names; omit to probe everything.' },
          server: { type: 'object', description: 'For apply/sync: a full canonical server definition (name, transport, command, args, env, url, headers, timeoutMs). For add: a single canonical entry, used only when config is omitted.' },
          config: { type: 'string', description: 'For add: the JSON configuration text. Accepts { "mcpServers": { "<name>": { … } } } (Trae/Cursor/Claude), { "servers": { … } } (VS Code), { "mcp": { … } } (OpenCode), { "context_servers": { … } } (Zed), a bare name→entry map, or one entry carrying "name". Every entry is re-encoded in the target tool\'s own dialect.' },
          reveal: { type: 'boolean', description: 'Return credential literals instead of masked values.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object' },
        render(_args, value) {
          if (!value || value.ok === false) return [{ type: 'text', text: `MCP operation failed${value?.code ? ` (${value.code})` : ''}: ${value?.error ?? 'unknown error'}` }];
          const data = value.data ?? value;
          /*
           * A manual add answers with the same fresh snapshot the toggle does.
           * Report the batch — what landed under which name, and every refusal —
           * instead of dumping the whole server list.
           */
          if (typeof data.added === 'number' && Array.isArray(data.results)) {
            const where = data.clientId === 'dsh' ? 'DeepSeek Harness' : `${data.clientId} (${data.scope})`;
            const lines = [`Added ${data.added} server(s) to ${where}${data.failed ? `, ${data.failed} refused` : ''}.`];
            for (const item of data.results) {
              if (item.ok) lines.push(`- ${item.displayName ?? item.name}${item.displayName && item.displayName !== item.name ? ` → ${item.name}` : ''}: written`);
              else lines.push(`- ${item.displayName ?? item.name}: ${item.code ?? 'error'} — ${item.error ?? 'refused'}`);
            }
            if (data.activating) lines.push('DeepSeek Harness is activating them; their tools appear in a moment.');
            else if (data.live) lines.push('They are live now — run "probe" to see which tools they expose.');
            return [{ type: 'text', text: lines.join('\n') }];
          }
          /*
           * A toggle answers with a fresh snapshot attached, which would dump
           * every server into the transcript. Report the one line that matters.
           */
          if (data.name && typeof data.enabled === 'boolean' && data.state) {
            const what = data.enabled ? 'mounted in DeepSeek Harness' : 'unmounted from DeepSeek Harness';
            const when = data.live
              ? ' — live now, its tools are callable'
              : (data.activating ? ' — DeepSeek Harness is activating it; its tools appear in a moment' : '');
            return [{ type: 'text', text: `${data.name}: ${what}${when}` }];
          }
          if (data.name && data.load && typeof data.loaded === 'boolean') {
            const before = data.before?.status ?? 'unknown';
            const after = data.load?.status ?? 'unknown';
            const lines = [`${data.name}: reconnect requested (was ${before}, now ${after}${data.load?.toolCount ? `, ${data.load.toolCount} tools` : ''}).`];
            if (data.loaded) lines.push('Its tools are registered and callable.');
            else if (after === 'failed') lines.push('Still no tools registered — run "probe" to see why the process will not start.');
            else lines.push('The connection is still settling; scan again in a moment.');
            for (const warning of data.warnings ?? []) lines.push(`warning: ${warning}`);
            return [{ type: 'text', text: lines.join('\n') }];
          }
          if (data.clients && data.servers) {
            const lines = [`${data.servers.length} MCP server(s) across ${data.clients.filter((client) => client.installed).length} installed tool(s).`];
            const summary = data.loadSummary;
            if (summary && summary.mounted > 0) {
              lines.push(summary.registry
                ? `Mounted in DeepSeek Harness: ${summary.mounted} — ${summary.loaded} loaded, ${summary.failed} failed to load${summary.off ? `, ${summary.off} off` : ''}${summary.pending ? `, ${summary.pending} activating` : ''}.`
                : `Mounted in DeepSeek Harness: ${summary.mounted}. The tool registry is unavailable, so load state cannot be checked.`);
            }
            for (const server of data.servers.slice(0, 40)) {
              /*
               * Mount state is the one thing a reader acts on, so it belongs on
               * the line rather than in a second pass over the payload. A
               * mounted-but-dead server is exactly what this feature exists to
               * expose, so it says FAILED rather than just "mounted".
               */
              const dsh = (server.targets ?? []).find((target) => target.clientId === 'dsh');
              const load = server.load?.status;
              const mount = !dsh
                ? ''
                : dsh.enabled === false
                  ? ' [dsh: off]'
                  : load === 'loaded'
                    ? ` [dsh: loaded, ${server.load.toolCount} tools]`
                    : load === 'failed'
                      ? ' [dsh: MOUNTED BUT FAILED TO LOAD]'
                      : load === 'pending'
                        ? ' [dsh: activating]'
                        : ' [dsh: mounted, load unknown]';
              lines.push(`- ${server.name} [${server.transport}]${mount} in: ${server.clients.join(', ') || 'none'}`);
            }
            if (data.servers.length > 40) lines.push(`… ${data.servers.length - 40} more`);
            return [{ type: 'text', text: lines.join('\n') }];
          }
          if (data.results) {
            const entries = Object.entries(data.results);
            const ok = entries.filter(([, item]) => item.status === 'ok').length;
            const lines = [`Probed ${entries.length} server(s): ${ok} healthy, ${entries.length - ok} failed.`];
            for (const [key, item] of entries) {
              lines.push(`- ${key}: ${item.status === 'ok' ? `ok (${item.toolCount} tools, ${item.elapsedMs}ms)` : `${item.code} — ${item.detail}`}`);
            }
            return [{ type: 'text', text: lines.join('\n') }];
          }
          if (data.yaml) return [{ type: 'text', text: data.yaml }];
          return [{ type: 'text', text: JSON.stringify(data, null, 2) }];
        },
      },
      async execute(args) {
        const body = {
          name: args.name,
          clientId: args.clientId,
          scope: args.scope,
          path: args.path,
          names: args.names,
          server: args.server,
          config: args.config,
          reveal: args.reveal === true,
          enabled: args.enabled,
          targets: (args.clientIds ?? []).map((clientId) => ({ clientId, scope: args.scope ?? 'global' })),
        };
        if (args.action === 'apply' || args.action === 'add' || args.action === 'remove' || args.action === 'sync' || args.action === 'toggle') {
          // A tool call must not silently overwrite a file the user edited.
          body.force = false;
        }
        if (args.action === 'add') {
          /* One explicit target: an add never fans out, so there is no list. */
          body.target = {
            clientId: args.clientId,
            scope: args.scope ?? (args.clientId === 'dsh' ? 'profile' : 'global'),
            path: args.path,
          };
        }
        const result = await dispatch(args.action, body);
        /* A tool answer is validated as lossless JSON; a scan snapshot is not. */
        return toLosslessJson(result);
      },
      presentCall(args) {
        return { card: 'generic', title: `MCP ${args.action}`, kind: 'edit', rawInput: args.name ?? args.action };
      },
    }), 'mcp-manager tool');
  }
}

export { maskValue, isSecretKey, isSecretValue, CLIENT_BY_ID, toLosslessJson };
