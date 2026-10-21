/**
 * DeepSeek Harness as one more MCP target.
 *
 * DSH stores MCP servers as `@deepseek-ai/dsh-mcp-client` rows in a cordis
 * composition, not as JSON. Writing those files by hand would mean guessing at
 * YAML form (including `!!js` expressions) and requiring a restart to see any
 * effect. `configEditor.edit()` does it properly: it validates the config
 * against the plugin's schema, persists it, and reconciles the Loader, and
 * mcp-client applies changes hot.
 *
 * Two constraints come from mcp-client's own schema and are enforced here
 * rather than discovered as a startup failure:
 *   - `serverName` must match `[A-Za-z0-9_-]{1,32}` and be unique per scope
 *   - `transport` is `stdio` or `streamable-http`; there is no `sse` and no
 *     separate timeout field beyond `toolCallTimeoutMs`
 */

import { dshMountName, sanitizeName } from './canonical.js';

export const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client';
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The plugin package a Loader entry instantiates.
 *
 * Read `options.name`, not `name`: the live Loader entry carries no `name`
 * property at all (verified on a running Host — `entry.name` is `undefined`
 * while `entry.options.name` is `'@deepseek-ai/dsh-mcp-client'`). Checking
 * `entry.name` silently matched zero rows, which made the scanner believe every
 * DSH server was still unreconciled in the patch layer and report it as
 * needing a restart. Accept both shapes so a future Loader that sets `name`
 * keeps working.
 */
function entryPackageName(entry) {
  if (!entry) return '';
  if (typeof entry.name === 'string') return entry.name;
  const options = entry.options;
  return options && typeof options.name === 'string' ? options.name : '';
}

/** Every composition row that is an MCP client. */
export function mcpEntries(configEditor) {
  if (!configEditor || typeof configEditor.configuration !== 'function') return [];
  try {
    return configEditor.configuration().filter((row) => {
      const name = entryPackageName(row && row.entry);
      return name === MCP_CLIENT_PACKAGE || name.endsWith('/dsh-mcp-client');
    });
  } catch {
    return [];
  }
}

/** Decode our canonical model from one mcp-client row config. */
export function decodeDshEntry(entry, config) {
  const raw = config && typeof config === 'object' ? config : {};
  const transport = raw.transport === 'streamable-http' ? 'http-stream' : 'stdio';
  const env = raw.env && typeof raw.env === 'object' ? { ...raw.env } : {};
  const headers = raw.headers && typeof raw.headers === 'object' ? { ...raw.headers } : {};
  return {
    name: raw.serverName ?? entry?.id ?? 'unknown',
    entryId: entry?.id,
    transport,
    command: raw.command ?? '',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env,
    cwd: raw.cwd,
    url: raw.url,
    headers,
    timeoutMs: typeof raw.toolCallTimeoutMs === 'number' ? raw.toolCallTimeoutMs : 60000,
    enabled: !(entry && entry.disabled === true),
    autoApprove: [],
    extra: {
      failOnStartupError: raw.failOnStartupError,
      reconnect: raw.reconnect,
    },
    secrets: [
      ...Object.entries(env).map(([key, value]) => ({ where: 'env', key, value })),
      ...Object.entries(headers).map(([key, value]) => ({ where: 'headers', key, value })),
    ]
      .filter((item) => /token|key|secret|password|auth|cookie/i.test(item.key) && typeof item.value === 'string' && item.value.length >= 12)
      .map(({ where, key }) => ({ where, key })),
    raw,
  };
}

/**
 * Encode the canonical model into an mcp-client config object.
 *
 * mcp-client has exactly two transports. A canonical `http-sse` has to become
 * `streamable-http`: collapsing it to `stdio` would emit a config with no
 * command (a row that never starts), which is worse than a transport hint the
 * connection may negotiate away.
 */
export function encodeDshEntry(server) {
  const remote = server.transport === 'http-stream' || server.transport === 'http-sse';
  /*
   * A caller may pass an already-mapped mount name (the scan reports it as
   * `mountName`); otherwise derive the same mapping from the display name so a
   * write and a later lookup always agree.
   */
  const mountName = server.mountName ? sanitizeName(server.mountName) : dshMountName(server.serverName ?? server.name);
  const config = { serverName: mountName, transport: remote ? 'streamable-http' : 'stdio' };
  if (!remote) {
    config.command = server.command;
    if (server.args && server.args.length) config.args = [...server.args];
    if (server.env && Object.keys(server.env).length) config.env = { ...server.env };
    if (server.cwd) config.cwd = server.cwd;
  } else {
    config.url = server.url;
    if (server.headers && Object.keys(server.headers).length) config.headers = { ...server.headers };
  }
  if (typeof server.timeoutMs === 'number' && server.timeoutMs > 0) config.toolCallTimeoutMs = server.timeoutMs;
  for (const key of ['failOnStartupError', 'reconnect']) {
    const value = server.extra?.[key];
    if (value !== undefined) config[key] = value;
  }
  return config;
}

/**
 * Add or replace one MCP server row. `previous` is the row to replace; when
 * absent a fresh row id is derived from the server name.
 */
export async function upsertDshServer(configEditor, { server, previous }) {
  const config = encodeDshEntry(server);
  if (!SERVER_NAME_RE.test(config.serverName)) {
    return { ok: false, code: 'error.dsh.badServerName', error: `serverName must match [A-Za-z0-9_-]{1,32}, got ${config.serverName}` };
  }
  const rows = mcpEntries(configEditor);
  const clash = rows.find((row) => row.entry && row.entry.id !== previous?.entry?.id && decodeDshEntry(row.entry, { ...row.inherited, ...row.override }).name === config.serverName);
  if (clash) {
    return { ok: false, code: 'error.dsh.duplicateName', error: `another MCP row already uses serverName ${config.serverName}` };
  }
  /*
   * DSH identifies a server by serverName, so a coerced name is a different
   * server than the one the user named. Report it instead of renaming quietly:
   * a 32-char truncation can also collide with a row that already exists, and
   * the user has to know before the row lands.
   *
   * One case is NOT a coercion and must stay silent: a name the harness cannot
   * accept at all (CJK, spaces, punctuation elsewhere) is mapped by
   * `dshMountName` on every path — write, scan, toggle, remove — so reporting
   * that mapping as a rename would look like a bug on every CJK server. The
   * test is whether the harness name is EXACTLY what plain sanitising produces:
   *   - too long, ASCII      → sanitize alone truncates, so the characters were
   *                            lost and the user has to hear about it
   *   - CJK / punctuation    → sanitize alone would collide, so dshMountName
   *                            appends a fingerprint and nothing was lost
   */
  const requested = String(server.serverName ?? server.name ?? '').trim();
  const truncated = requested && sanitizeName(requested, '') === config.serverName;
  const renamed = requested && requested !== config.serverName && truncated
    ? { from: requested, to: config.serverName }
    : undefined;
  if (previous) {
    try {
      await configEditor.edit(previous.entry, (current, inherited) => ({ ...inherited, ...current, ...config }));
    } catch (error) {
      return { ok: false, code: 'error.dsh.write', error: String(error && error.message ? error.message : error) };
    }
    return { ok: true, entryId: previous.entry.id, serverName: config.serverName, ...(renamed ? { renamed } : {}) };
  }
  return { ok: false, code: 'error.dsh.insertUnsupported', error: 'adding a new MCP row requires the patch layer; see the generated snippet' };
}

/** Remove one MCP server row. */
export async function removeDshServer(configEditor, row) {
  if (!row) return { ok: false, code: 'error.dsh.missing', error: 'no MCP row to remove' };
  try {
    await configEditor.edit(row.entry, (current, inherited) => {
      const next = { ...inherited, ...current };
      delete next.serverName;
      return next;
    });
  } catch (error) {
    return { ok: false, code: 'error.dsh.write', error: String(error && error.message ? error.message : error) };
  }
  return { ok: true };
}

/**
 * Mount or unmount one MCP row inside DSH.
 *
 * This is deliberately NOT a config write. mcp-client's schema has no
 * `enabled` field, so "off" cannot be expressed as configuration; the Loader
 * row's own `disabled` flag is the only real off switch, and `pluginManager`
 * owns it. Using it means the process really disposes the plugin (its tools
 * disappear) and really re-initialises it, and that nothing outside DSH is
 * touched — no other client's config file is rewritten.
 *
 * `entryId` is the Loader row identity from `listPlugins`/`configuration()`.
 * A server that only exists in the patch layer has no identity until the
 * Loader reconciles it, so the caller has to report that instead of guessing.
 */
export async function setDshServerEnabled(pluginManager, entryId, enabled) {
  if (!pluginManager || typeof pluginManager.setPluginEnabled !== 'function') {
    return { ok: false, code: 'error.dsh.noManager', error: 'the plugin manager service is not available in this process' };
  }
  if (!entryId) {
    return {
      ok: false,
      code: 'error.dsh.noEntry',
      error: 'this server has no Loader row yet',
      hint: 'it was written to the profile patch and the Loader has not reconciled it; reload the page to pick up the live row',
    };
  }
  let result;
  try {
    result = await pluginManager.setPluginEnabled(entryId, enabled === true);
  } catch (error) {
    return { ok: false, code: 'error.dsh.toggle', error: String(error && error.message ? error.message : error) };
  }
  const application = result && result.application;
  if (application === 'overridden') {
    // A higher-priority composition layer decides this row; flipping it here
    // would appear to succeed and then revert on the next reload.
    return { ok: false, code: 'error.dsh.overridden', error: result.error?.diagnostic ?? 'a higher-priority layer overrides this row' };
  }
  if (application === 'failed' || application === 'cancelled') {
    return {
      ok: false,
      code: 'error.dsh.toggle',
      error: result.error?.diagnostic ?? `the plugin manager answered ${application}`,
      managerCode: result.error?.code,
    };
  }
  return {
    ok: true,
    entryId,
    enabled: enabled === true,
    enabledOnDisk: result?.enabled,
    changed: result?.changed === true,
    restartRequired: application === 'restart-required',
    warnings: result?.warnings ?? [],
  };
}

/** YAML snippet a user can paste to add a new row (we cannot insert rows). */
export function dshSnippet(server) {
  const config = encodeDshEntry(server);
  const lines = [`- insert:`, `    - id: mcp-${config.serverName}`, `      name: '${MCP_CLIENT_PACKAGE}'`, `      config:`];
  const walk = (object, depth) => {
    for (const [key, value] of Object.entries(object)) {
      const pad = ' '.repeat(depth);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        lines.push(`${pad}${key}:`);
        walk(value, depth + 2);
      } else if (Array.isArray(value)) {
        lines.push(`${pad}${key}:`);
        for (const item of value) lines.push(`${pad}  - ${JSON.stringify(item)}`);
      } else {
        lines.push(`${pad}${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
      }
    }
  };
  walk(config, 8);
  return `${lines.join('\n')}\n`;
}
