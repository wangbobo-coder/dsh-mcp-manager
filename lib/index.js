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
import { createStore } from './store.js';
import { scanAll } from './scan.js';
import { probeMany, probeServer } from './probe.js';
import { applyServerToTarget, removeServer, syncServer, snippetFor } from './ops.js';
import { CLIENTS, CLIENT_BY_ID } from './adapters.js';
import { redactServer, isSecretKey, isSecretValue, maskValue, dshMountName } from './canonical.js';
import { toggleServer } from './toggle.js';
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

export function apply(ctx, config = {}) {
  const options = {
    probeTimeoutMs: Number.isFinite(config.probeTimeoutMs) ? config.probeTimeoutMs : 20000,
    backupsToKeep: Number.isFinite(config.backupsToKeep) ? config.backupsToKeep : 20,
    includeProjectScope: config.includeProjectScope !== false,
    probeConcurrency: Number.isFinite(config.probeConcurrency) ? config.probeConcurrency : 4,
  };

  const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh');
  const store = createStore({ root: join(home, 'mcp-manager'), backupsToKeep: options.backupsToKeep });
  store.ensureDirs();

  /*
   * The patch layer lives in the profile directory, which the harness exports
   * separately from DSH_HOME; derive it so a non-default profile still works.
   */
  const profileDir = process.env.DSH_PROFILE_DIR || join(home, 'profiles', process.env.DSH_PROFILE || 'desktop');

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
   * The supported lever is `hmr.reconcileProfile(requiredIds)`: it recomposes the
   * profile, re-imports the entry, and — because the id is listed as required —
   * reports its inactivity instead of silently tolerating it. That re-runs the
   * connection, which is exactly the retry the user asked for. Serialized through
   * `runExclusive` so it cannot race an automatic reload.
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

    const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined;
    if (!hmr || typeof hmr.reconcileProfile !== 'function') {
      return { ok: false, code: 'error.dsh.noHmr', error: 'the hot-reload service is not available, so the connection cannot be re-run' };
    }

    const before = node.load ?? null;
    try {
      const run = () => hmr.reconcileProfile([target.entryId]);
      const reconciled = typeof hmr.runExclusive === 'function' ? await hmr.runExclusive(run) : await run();
      const after = snapshot(false).servers.find((item) => item.name === name);
      const load = after?.load ?? null;
      /* A reconcile that succeeds only proves the profile recomposed. Whether the
         connection came back is decided by the registry, read again after it. */
      return {
        ok: true,
        name,
        entryId: target.entryId,
        before,
        load,
        loaded: load?.status === 'loaded',
        warnings: Array.isArray(reconciled?.warnings) ? reconciled.warnings : [],
        pending: Array.isArray(reconciled?.pending) ? reconciled.pending.map((item) => item.reason) : [],
        restartReason: reconciled?.restartReason ?? null,
        state: snapshot(false),
      };
    } catch (error) {
      return { ok: false, code: 'error.dsh.retry', error: String(error && error.message ? error.message : error) };
    }
  }

  const dispatch = async (action, body = {}) => {
    switch (action) {
      case 'scan': return opScan(body);
      case 'probe': return opProbe(body);
      case 'apply': return opApply(body);
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
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['scan', 'probe', 'apply', 'remove', 'sync', 'snippet', 'toggle', 'reveal', 'retry', 'history'], description: 'Operation to perform.' },
          name: { type: 'string', description: 'Server name, as reported by scan.' },
          enabled: { type: 'boolean', description: 'For toggle: true mounts the server in DeepSeek Harness, false unmounts it.' },
          clientId: { type: 'string', description: 'Target client id (see scan output).' },
          scope: { type: 'string', enum: ['global', 'project', 'profile'], description: 'Target scope. Defaults to global.' },
          path: { type: 'string', description: 'Explicit target file path, overriding the client/scope resolution.' },
          clientIds: { type: 'array', items: { type: 'string' }, description: 'For sync: client ids to copy the definition into.' },
          names: { type: 'array', items: { type: 'string' }, description: 'For probe: server names; omit to probe everything.' },
          server: { type: 'object', description: 'For apply/sync: a full canonical server definition (name, transport, command, args, env, url, headers, timeoutMs).' },
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
          reveal: args.reveal === true,
          enabled: args.enabled,
          targets: (args.clientIds ?? []).map((clientId) => ({ clientId, scope: args.scope ?? 'global' })),
        };
        if (args.action === 'apply' || args.action === 'remove' || args.action === 'sync' || args.action === 'toggle') {
          // A tool call must not silently overwrite a file the user edited.
          body.force = false;
        }
        const result = await dispatch(args.action, body);
        return result;
      },
      presentCall(args) {
        return { card: 'generic', title: `MCP ${args.action}`, kind: 'edit', rawInput: args.name ?? args.action };
      },
    }), 'mcp-manager tool');
  }
}

export { maskValue, isSecretKey, isSecretValue, CLIENT_BY_ID };
