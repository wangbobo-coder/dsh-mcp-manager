/**
 * Read-only discovery: walk every declared client location, decode what is
 * there, and produce the matrix the UI renders.
 *
 * The scan never writes and never throws: a missing file is a client that is
 * not installed, an unparsable file is a warning attached to that location, and
 * one broken client never hides the rest. Everything a client cannot express
 * becomes an explicit capability gap rather than a silently dropped field.
 */

import { CLIENTS, resolveClientPaths } from './adapters.js';
import { decodeEntry, definitionHash, dshMountName, redactServer } from './canonical.js';
import { readContainer, readTomlServers, readYamlServers } from './surgical.js';
import { mcpEntries, decodeDshEntry } from './dsh.js';
import { readDshPatchServers } from './dsh-patch.js';

const READ_KINDS = new Set(['json', 'toml', 'yaml']);

/** Read one location and decode its servers. */
function readLocation(store, client, location) {
  if (!READ_KINDS.has(client.format)) return { ok: true, exists: false, servers: {}, empty: true };
  const read = store.readFile(location.path);
  if (!read.ok) return { ok: false, exists: true, servers: {}, error: read.error };
  if (!read.exists) return { ok: true, exists: false, servers: {}, hash: null, text: '' };
  if (!read.text.trim()) return { ok: true, exists: true, servers: {}, hash: read.hash, text: read.text, empty: true };

  let raw;
  try {
    if (client.format === 'toml') raw = readTomlServers(read.text);
    else if (client.format === 'yaml') raw = readYamlServers(read.text);
    else {
      const container = readContainer(read.text, client.containerKey);
      if (!container.ok) return { ok: false, exists: true, servers: {}, error: container.error, hash: read.hash, text: read.text };
      raw = container.value ?? {};
    }
  } catch (error) {
    return { ok: false, exists: true, servers: {}, error: String(error && error.message ? error.message : error), hash: read.hash, text: read.text };
  }

  const servers = {};
  for (const [name, entry] of Object.entries(raw ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    const dialect = { ...client.dialect };
    // Gemini/Qwen: `httpUrl` means streamable HTTP, `url` means SSE. Decode both.
    if (client.id === 'gemini' || client.id === 'qwen') {
      if (typeof entry.httpUrl === 'string' && entry.httpUrl) dialect.urlKey = 'httpUrl';
      else if (typeof entry.url === 'string' && entry.url) { dialect.urlKey = 'url'; dialect.typeMap = { ...dialect.typeMap }; entry.__sseHint = 'sse'; }
    }
    servers[name] = decodeEntry(name, entry, dialect);
  }
  return { ok: true, exists: true, servers, hash: read.hash, text: read.text, mtimeMs: read.mtimeMs };
}

/**
 * Decode DSH's own MCP servers: live rows plus anything still pending in the
 * patch layer. Live rows win on a name clash — once the Loader has reconciled,
 * the patch item and the live row are the same server.
 */
function readDsh(configEditor, profileDir) {
  const rows = mcpEntries(configEditor);
  const servers = {};
  for (const row of rows) {
    const config = { ...row.inherited, ...row.override };
    const decoded = decodeDshEntry(row.entry, config);
    decoded.rowId = row.entry?.id;
    servers[decoded.name] = decoded;
  }
  let pending = 0;
  for (const item of readDshPatchServers(profileDir)) {
    if (servers[item.name]) continue;
    servers[item.name] = item;
    pending += 1;
  }
  return { ok: true, exists: rows.length + pending > 0, servers, rows, pending };
}

/**
 * Fold DSH mount names back onto the display names the user sees.
 *
 * A server mounted in the harness lives under `dshMountName(displayName)`,
 * because `serverName` may only use `[A-Za-z0-9_-]` — a CJK name has to be
 * mapped. Without this pass the mounted row appears as a SEVENTH server named
 * `API-c2f500c4` next to `表单管理系统 - API 文档`, and the display-named node has
 * no `dsh` target at all, so its switch reads "off" while the server is in fact
 * mounted.
 *
 * Two sources are inverted into the mapping, because either can be the only one
 * that knows the display name:
 *
 *   1. Every server another client declares. `dshMountName` is a pure function
 *      of the display name, so it can be run forward over those names and the
 *      result compared.
 *   2. The ownership ledger, which stores the display name beside the mount name
 *      when we wrote the row. This covers a server mounted from a client config
 *      the user has since deleted, and a row mounted by hand.
 *
 * A row whose mount name matches neither keeps its own name — inventing a
 * prettier name for someone else's hand-written row would hide the truth.
 */
function foldDshNames(matrix, sources, store) {
  const mounts = new Map();
  for (const [key, node] of matrix.entries()) {
    if (!node.targets.some((item) => item.clientId !== 'dsh')) continue;
    const mount = dshMountName(key);
    if (mount !== key && !mounts.has(mount)) mounts.set(mount, key);
  }
  try {
    const owned = typeof store?.allOwnership === 'function' ? store.allOwnership() : null;
    for (const [mountName, bucket] of Object.entries(owned ?? {})) {
      const targets = bucket?.targets ?? {};
      for (const value of Object.values(targets)) {
        const display = value?.displayName;
        if (typeof display === 'string' && display && display !== mountName && !mounts.has(mountName)) {
          mounts.set(mountName, display);
          break;
        }
      }
    }
  } catch {
    /* A ledger we cannot read must not break the scan; the file-based fold
       above still covers every server a client declares. */
  }

  for (const [key, node] of [...matrix.entries()]) {
    const display = mounts.get(key);
    if (!display || display === key) continue;
    if (!matrix.has(display)) {
      /* Nothing else declared this display name, so rename the node in place
         rather than moving targets onto a node that does not exist. */
      matrix.delete(key);
      node.name = display;
      for (const item of node.targets) item.mountedAs = key;
      matrix.set(display, node);
      continue;
    }
    // Move this node's targets onto the display-named node.
    for (const item of node.targets) {
      item.mountedAs = key;
      matrix.get(display).targets.push(item);
    }
    matrix.delete(key);
  }

  for (const source of sources) {
    if (source.clientId !== 'dsh') continue;
    for (const item of source.servers) {
      const display = mounts.get(item.name);
      if (display && display !== item.name) {
        item.mountName = item.name;
        item.name = display;
      }
    }
  }
}

/**
 * Build the full snapshot.
 *
 *   projectRoots — workspace directories whose project-scope files to include
 *   reveal       — return credential literals instead of masked values
 *
 * Two projections are produced from one read, because they answer different
 * questions and recomputing them separately would let them disagree:
 *   servers — one node per server name, listing every place it appears
 *   sources — one node per config FILE (the directory-first view), listing the
 *             servers that file holds. This is what the page groups by, since
 *             "which directory holds which MCP" is a per-file question.
 */
export function scanAll({ store, configEditor, projectRoots = [], reveal = false, profileDir }) {
  const warnings = [];
  const clients = [];
  const matrix = new Map();
  const locations = [];
  const sources = [];

  const registerServer = (clientId, clientLabel, scope, path, server, fileHash) => {
    if (!matrix.has(server.name)) {
      matrix.set(server.name, { name: server.name, targets: [], canonical: server });
    }
    const node = matrix.get(server.name);
    const target = {
      clientId,
      clientLabel,
      scope,
      path,
      hash: fileHash,
      fingerprint: definitionHash(server),
      transport: server.transport,
      enabled: server.enabled,
      // Only a Loader row can be switched: the switch unmounts the DSH plugin.
      entryId: server.entryId ?? null,
      pending: server.pending === true,
      server: redactServer(server, reveal),
    };
    node.targets.push(target);
    // Prefer the stdio/DSH definition as the canonical shape when several exist.
    if (clientId === 'dsh' || (node.canonical.transport !== 'stdio' && server.transport === 'stdio')) node.canonical = server;
  };

  for (const client of CLIENTS) {
    const entry = {
      id: client.id,
      label: client.label,
      order: client.order,
      format: client.format,
      managed: client.managed === true,
      readOnly: client.readOnly === true,
      caps: client.caps,
      note: client.note,
      installed: false,
      locations: [],
      serverCount: 0,
    };
    if (client.managed) {
      const dsh = readDsh(configEditor, profileDir);
      entry.installed = true;
      entry.serverCount = Object.keys(dsh.servers).length;
      if (dsh.pending) entry.pendingCount = dsh.pending;
      entry.locations.push({ scope: 'profile', path: '(profile composition)', exists: dsh.exists, serverCount: entry.serverCount });
      const sourceServers = Object.values(dsh.servers);
      for (const server of sourceServers) registerServer(client.id, client.label, 'profile', '(profile composition)', server, null);
      sources.push({
        id: `${client.id}:profile:(profile composition)`,
        clientId: client.id,
        clientLabel: client.label,
        scope: 'profile',
        path: '(profile composition)',
        format: 'composition',
        managed: true,
        readOnly: false,
        switchable: true,
        exists: true,
        serverCount: sourceServers.length,
        pendingCount: dsh.pending,
        servers: sourceServers.map((server) => ({
          name: server.name,
          transport: server.transport,
          enabled: server.enabled,
          entryId: server.entryId ?? null,
          pending: server.pending === true,
          secrets: (server.secrets ?? []).map((item) => item.key),
          timeoutMs: server.timeoutMs,
          server: redactServer(server, reveal),
        })),
      });
      clients.push(entry);
      continue;
    }
    const paths = resolveClientPaths(client, projectRoots[0]);
    for (const location of paths) {
      if (location.scope === 'project' && projectRoots.length === 0) continue;
      const targets = location.scope === 'project' ? projectRoots.map((root) => resolveClientPaths(client, root).find((item) => item.scope === 'project' && item.path.endsWith(location.relative))) : [location];
      for (const target of targets) {
        if (!target) continue;
        const read = readLocation(store, client, target);
        entry.locations.push({ scope: target.scope, path: target.path, exists: read.exists, serverCount: Object.keys(read.servers ?? {}).length, hash: read.hash ?? null });
        locations.push({ clientId: client.id, scope: target.scope, path: target.path, hash: read.hash ?? null, exists: read.exists });
        if (!read.ok) warnings.push({ code: 'error.scan.parse', clientId: client.id, path: target.path, error: read.error });
        if (read.exists) entry.installed = true;
        const names = Object.keys(read.servers ?? {});
        entry.serverCount += names.length;
        if (read.exists) {
          sources.push({
            id: `${client.id}:${target.scope}:${target.path}`,
            clientId: client.id,
            clientLabel: client.label,
            scope: target.scope,
            path: target.path,
            format: client.format,
            managed: false,
            readOnly: client.readOnly === true,
            // We never toggle another tool's own file: that would edit the
            // original directory the user asked us to leave alone.
            switchable: false,
            exists: true,
            hash: read.hash ?? null,
            empty: read.empty === true,
            serverCount: names.length,
            servers: names.map((name) => {
              const server = read.servers[name];
              return {
                name,
                transport: server.transport,
                enabled: server.enabled,
                entryId: null,
                pending: false,
                secrets: (server.secrets ?? []).map((item) => item.key),
                timeoutMs: server.timeoutMs,
                server: redactServer(server, reveal),
              };
            }),
          });
        }
        for (const name of names) {
          registerServer(client.id, client.label, target.scope, target.path, read.servers[name], read.hash);
        }
      }
    }
    clients.push(entry);
  }

  // Reconcile harness mount names with the display names other clients use,
  // BEFORE the servers projection is built: the fold rewrites matrix keys.
  foldDshNames(matrix, sources, store);

  const servers = [...matrix.values()].map((node) => {
    const clientIds = new Set(node.targets.map((target) => target.clientId));
    const canonical = node.canonical;
    const drift = [];
    for (const target of node.targets) {
      const other = matrix.get(node.name);
      if (!other) continue;
      if (target.fingerprint !== definitionHash(canonical)) drift.push({ clientId: target.clientId, scope: target.scope, path: target.path });
    }
    return {
      name: node.name,
      transport: canonical.transport,
      enabled: canonical.enabled,
      secrets: canonical.secrets ?? [],
      timeoutMs: canonical.timeoutMs,
      clientCount: clientIds.size,
      clients: [...clientIds],
      targets: node.targets,
      drift,
      canonical: redactServer(canonical, reveal),
    };
  }).sort((a, b) => b.clientCount - a.clientCount || a.name.localeCompare(b.name));

  // Which secrets are literal on disk, for the security banner.
  const literalSecrets = [];
  for (const node of matrix.values()) {
    for (const item of node.canonical.secrets ?? []) {
      const target = node.targets[0];
      literalSecrets.push({
        server: node.name,
        where: item.where,
        key: item.key,
        clientId: target?.clientId ?? null,
        path: target?.path ?? null,
      });
    }
  }

  return {
    clients,
    servers,
    sources,
    locations,
    warnings,
    literalSecrets,
    scannedAt: new Date().toISOString(),
  };
}
