/**
 * Adding MCP rows to DeepSeek Harness, not just editing existing ones.
 *
 * `configEditor.edit()` can only rewrite a row that already exists; a brand-new
 * MCP server has no entry to address. The composition's patch layer is the
 * supported insertion point (`- insert:` is a documented top-level patch
 * entry), so new servers are appended there and existing ones are rewritten
 * through configEditor.
 *
 * These helpers only touch `- insert:` items that this plugin created (matched
 * by the `mcp-<serverName>` id plus the mcp-client package name), so a user's
 * own patch entries — provider configs, agency agents, anything hand-written —
 * are never rewritten. Every write is backed up by the store first.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { MCP_CLIENT_PACKAGE, encodeDshEntry } from './dsh.js';

const INSERT_ID_PREFIX = 'mcp-';

/** Where the active profile keeps its patch layer. */
export function profilePatchPath(profileDir) {
  const base = profileDir ?? process.env.DSH_PROFILE_DIR ?? (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles', 'desktop') : undefined);
  if (!base) return undefined;
  return join(base, 'cordis.patch.yml');
}

/**
 * Split a patch file into its preamble (comments before the first entry) and
 * its top-level `- ` items, keeping each item's source text verbatim.
 *
 * A byte-preserving split is what makes targeted removal safe: rebuilding the
 * file from items we did not author would reformat the user's own entries.
 */
export function splitPatchItems(text) {
  const lines = text.split('\n');
  const preamble = [];
  const items = [];
  let current = null;
  for (const line of lines) {
    if (/^- /.test(line)) {
      if (current) items.push(current);
      current = [];
    }
    if (current) current.push(line);
    else preamble.push(line);
  }
  if (current) items.push(current);
  return {
    preamble: preamble.join('\n'),
    items: items.map((itemLines) => ({ lines: itemLines, text: itemLines.join('\n') })),
  };
}

/** True when this patch item is an mcp-client row this plugin owns. */
function isOurMcpItem(itemText, serverName) {
  if (!/^- insert:/.test(itemText)) return false;
  if (!itemText.includes(MCP_CLIENT_PACKAGE)) return false;
  const wanted = `${INSERT_ID_PREFIX}${serverName}`;
  return new RegExp(`^\\s*-\\s+id:\\s*["']?${escapeRegExp(wanted)}["']?\\s*$`, 'm').test(itemText);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when this patch item is the enablement override the plugin manager
 * appends for one of our rows.
 *
 * `pluginManager.setPluginEnabled` does not rewrite the row: it appends a
 * separate top-level item that targets the row by id with nothing but
 * `disabled:`. That item is a second thing on disk describing the same server,
 * so removal has to take it too — a targeted patch entry pointing at an id no
 * longer in the tree is a dangling override.
 */
function isToggleOverrideItem(itemText, serverName) {
  if (/^- insert:/.test(itemText)) return false;
  if (!/^\s*disabled:\s*(true|false|null)\s*$/m.test(itemText)) return false;
  const wanted = `${INSERT_ID_PREFIX}${serverName}`;
  return new RegExp(`^-\\s+id:\\s*["']?${escapeRegExp(wanted)}["']?\\s*$`, 'm').test(itemText);
}

/** Is one of our servers currently disabled by a plugin-manager override? */
function isDisabledByOverride(itemText, serverName) {
  if (!isToggleOverrideItem(itemText, serverName)) return false;
  return /^\s*disabled:\s*true\s*$/m.test(itemText);
}

/**
 * Switch one of our patch-layer servers on or off before its row has mounted.
 *
 * This writes the same shape `pluginManager.setPluginEnabled` writes: a
 * top-level item targeting the row by id with nothing but `disabled:`. It is
 * deliberately not a rewrite of the insert item, so the server definition the
 * user pasted stays byte-identical and re-enabling restores the file exactly.
 */
export function setDshPatchDisabled({ serverName, disabled, store, profileDir }) {
  const path = profilePatchPath(profileDir);
  if (!path || !existsSync(path)) return { ok: false, code: 'error.dsh.missing', error: 'no profile patch file' };
  const before = readFileSync(path, 'utf8');
  const { preamble, items } = splitPatchItems(before);
  const hasRow = items.some((item) => isOurMcpItem(item.text, serverName));
  if (!hasRow) return { ok: false, code: 'error.dsh.missing', error: `no patch row for ${serverName}` };
  const others = items.filter((item) => !isToggleOverrideItem(item.text, serverName));
  const id = `${INSERT_ID_PREFIX}${serverName}`;
  const next = disabled ? [...others.map((item) => item.text.trimEnd()), `- id: ${id}\n  disabled: true`] : others.map((item) => item.text.trimEnd());
  const head = preamble.trimEnd();
  const after = (head ? [head, ...next] : next).join('\n');
  const text = after ? `${after}\n` : '';
  if (text === before) return { ok: true, changed: false, path, serverName };
  if (store && typeof store.backup === 'function') {
    try {
      store.backup(path, before);
    } catch { /* the item is a reversible one-liner; a missing backup cannot lose data */ }
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
  return { ok: true, changed: true, path, serverName, restartRequired: true };
}

/** Render one `- insert:` patch item for a server. */
export function renderInsertItem(server) {
  const config = encodeDshEntry(server);
  const lines = [
    '- insert:',
    `    - id: ${INSERT_ID_PREFIX}${config.serverName}`,
    `      name: '${MCP_CLIENT_PACKAGE}'`,
    '      config:',
  ];
  const walk = (object, depth) => {
    for (const [key, value] of Object.entries(object)) {
      const pad = ' '.repeat(depth);
      if (Array.isArray(value)) {
        lines.push(`${pad}${key}:`);
        for (const entry of value) lines.push(`${pad}  - ${JSON.stringify(entry)}`);
      } else if (value && typeof value === 'object') {
        lines.push(`${pad}${key}:`);
        walk(value, depth + 2);
      } else {
        lines.push(`${pad}${key}: ${typeof value === 'string' ? JSON.stringify(value) : value}`);
      }
    }
  };
  walk(config, 8);
  return { text: lines.join('\n'), serverName: config.serverName };
}

/**
 * Add one server to the patch layer, or replace the item this plugin wrote
 * earlier for the same serverName.
 *
 * Returns `{ ok, changed, path, serverName }`; `changed:false` means the exact
 * item was already present, so a repeated apply is a no-op rather than a
 * duplicate row.
 */
export function writeDshPatchServer({ server, store, profileDir }) {
  const path = profilePatchPath(profileDir);
  if (!path) return { ok: false, code: 'error.dsh.noProfile', error: 'cannot locate the active DSH profile' };
  const existed = existsSync(path);
  const before = existed ? readFileSync(path, 'utf8') : '';
  const { text: itemText, serverName } = renderInsertItem(server);

  const { preamble, items } = splitPatchItems(before);
  const kept = [];
  let replaced = false;
  for (const item of items) {
    if (isOurMcpItem(item.text, serverName)) {
      if (item.text.trim() === itemText.trim()) replaced = true;
      continue; // drop; the fresh item is appended below
    }
    kept.push(item.text);
  }
  if (replaced) return { ok: true, changed: false, path, serverName };

  const head = preamble.trimEnd();
  const chunks = [];
  if (head) chunks.push(head);
  for (const item of kept) chunks.push(item.trimEnd());
  chunks.push(itemText);
  const after = `${chunks.join('\n')}\n`;

  if (store && typeof store.backup === 'function') {
    try {
      store.backup(path, before);
    } catch { /* a missing backup must not block the write; the item is additive */ }
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, after, 'utf8');
  renameSync(temp, path);
  return { ok: true, changed: true, path, serverName, created: !existed };
}

/** Remove the patch item this plugin wrote for one serverName. */
export function removeDshPatchServer({ serverName, store, profileDir }) {
  const path = profilePatchPath(profileDir);
  if (!path || !existsSync(path)) return { ok: true, changed: false, path };
  const before = readFileSync(path, 'utf8');
  const { preamble, items } = splitPatchItems(before);
  // Take the enablement override with the row, or the override outlives its target.
  const kept = items.filter((item) => !isOurMcpItem(item.text, serverName) && !isToggleOverrideItem(item.text, serverName));
  if (kept.length === items.length) return { ok: true, changed: false, path };

  if (store && typeof store.backup === 'function') {
    try {
      store.backup(path, before);
    } catch { /* keep going: the write itself is still safe */ }
  }
  const head = preamble.trimEnd();
  const chunks = head ? [head, ...kept.map((item) => item.text.trimEnd())] : kept.map((item) => item.text.trimEnd());
  const after = chunks.length ? `${chunks.join('\n')}\n` : '';
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, after, 'utf8');
  renameSync(temp, path);
  return { ok: true, changed: true, path };
}

/** Does the patch layer already carry an item for this serverName? */
export function patchHasServer(serverName, profileDir) {
  const path = profilePatchPath(profileDir);
  if (!path || !existsSync(path)) return false;
  const { items } = splitPatchItems(readFileSync(path, 'utf8'));
  return items.some((item) => isOurMcpItem(item.text, serverName));
}

/**
 * Read the MCP servers this plugin put in the patch layer.
 *
 * These are *pending*: the row exists on disk but only becomes a live entry
 * after the Loader reconciles (a restart). `scanAll` merges them with the live
 * rows, live first, so a server is never counted twice once it has taken
 * effect, and the UI can still show one that was just written.
 */
export function readDshPatchServers(profileDir) {
  const path = profilePatchPath(profileDir);
  if (!path || !existsSync(path)) return [];
  const out = [];
  const { items } = splitPatchItems(readFileSync(path, 'utf8'));
  for (const item of items) {
    if (!/^- insert:/.test(item.text) || !item.text.includes(MCP_CLIENT_PACKAGE)) continue;
    const idMatch = item.text.match(/^\s*-\s+id:\s*["']?([^"'\s]+)["']?\s*$/m);
    if (!idMatch || !idMatch[1].startsWith(INSERT_ID_PREFIX)) continue;
    const server = parseInsertItem(item.text);
    if (!server) continue;
    // A plugin-manager override can switch this row off without touching it.
    const disabled = items.some((other) => isDisabledByOverride(other.text, server.name));
    out.push({ ...server, enabled: !disabled, pending: true, patchPath: path, patchId: idMatch[1] });
  }
  return out;
}

/**
 * Pull the `config:` block out of one insert item.
 *
 * The block this plugin writes is deliberately shallow (scalars, string lists,
 * and one level of string maps for env/headers), so a small purpose-built
 * reader is enough and avoids adding a YAML dependency to the bundle.
 */
function parseInsertItem(itemText) {
  const lines = itemText.split('\n');
  const start = lines.findIndex((line) => /^\s+config:\s*$/.test(line));
  if (start < 0) return null;
  const configIndent = lines[start].match(/^\s*/)[0].length;
  const config = {};
  let currentKey = null;
  let currentIndent = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= configIndent) break;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem) {
      if (currentKey) {
        /* A key with no inline value is a map or a list; the first item decides. */
        if (!Array.isArray(config[currentKey])) config[currentKey] = [];
        config[currentKey].push(unquote(listItem[1]));
      }
      continue;
    }
    const pair = line.match(/^\s*([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!pair) continue;
    const [, key, rest] = pair;
    if (rest === '') {
      currentKey = key;
      currentIndent = indent;
      config[key] = config[key] ?? {};
      continue;
    }
    if (currentKey && indent > currentIndent && typeof config[currentKey] === 'object' && !Array.isArray(config[currentKey])) {
      config[currentKey][key] = unquote(rest);
      continue;
    }
    currentKey = null;
    config[key] = rest === '[]' ? [] : unquote(rest);
  }
  if (!config.serverName) return null;
  return {
    name: config.serverName,
    transport: config.transport === 'streamable-http' ? 'http-stream' : 'stdio',
    command: config.command,
    args: Array.isArray(config.args) ? config.args : config.args ? [config.args] : [],
    env: typeof config.env === 'object' && !Array.isArray(config.env) ? config.env : {},
    headers: typeof config.headers === 'object' && !Array.isArray(config.headers) ? config.headers : {},
    url: config.url,
    timeoutMs: typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : undefined,
    enabled: true,
    pending: true,
  };
}

function unquote(value) {
  const text = String(value).trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^'.*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  if (/^".*"$/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}
