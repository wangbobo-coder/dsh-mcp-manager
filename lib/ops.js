/**
 * Mutations: the operations the UI buttons and the agent tool both call.
 *
 * Both callers go through these exact functions (see the plugin reference on
 * user actions and agent tools): one implementation, two entry points, so the
 * tool's result and the UI's result cannot drift apart.
 *
 * Every write is a guarded compare-and-set against the file hash the caller
 * read (see store.mutate). Project-scope targets additionally refuse literal
 * credentials, because those files are committed to repositories.
 */

import { CLIENT_BY_ID, resolveClientPaths } from './adapters.js';
import { TRANSPORTS, decodeEntry, definitionHash, dshMountName, encodeEntry, isSecretKey, isSecretValue, isMaskedValue, isReferenceValue, secretArgs, sameDefinition, sanitizeName, uniqueName } from './canonical.js';
import { readContainer, removeContainerEntry, writeContainerEntry, readTomlServers, writeTomlServer, removeTomlServer } from './surgical.js';
import { dshSnippet, mcpEntries, upsertDshServer } from './dsh.js';
import { patchHasServer, writeDshPatchServer, removeDshPatchServer } from './dsh-patch.js';

const WRITABLE_KINDS = new Set(['json', 'toml']);

/**
 * Does this server carry a credential literal that must not be committed?
 *
 * Key-driven, matching the masking policy: a project-scope file must not
 * receive a plaintext credential even when the value is short. Arguments are
 * checked too — `npx some-mcp --api-key=…` is a real invocation shape.
 */
export function hasLiteralSecret(server) {
  for (const map of [server.env, server.headers]) {
    for (const [key, value] of Object.entries(map ?? {})) {
      if (isSecretKey(key) && !isReferenceValue(value) && String(value ?? '').length > 0) {
        return { key, where: map === server.env ? 'env' : 'header' };
      }
    }
  }
  for (const found of secretArgs(server.args)) {
    if (!isReferenceValue(String(found.value))) return { key: found.key, where: 'args' };
  }
  return null;
}

/**
 * Does this server carry a redaction placeholder anywhere a credential lives?
 *
 * Checked separately from `hasLiteralSecret` because the two failures want
 * different messages: a literal is a policy refusal, while a mask means the
 * caller sent back the browser's redacted copy and the real value is missing.
 */
export function maskedField(server) {
  for (const [where, map] of [['env', server.env], ['header', server.headers]]) {
    for (const [key, value] of Object.entries(map ?? {})) {
      if (isMaskedValue(value)) return { key, where };
    }
  }
  for (const found of secretArgs(server.args)) {
    if (isMaskedValue(String(found.value))) return { key: found.key, where: 'args' };
  }
  return null;
}

/* ------------------------------------------------- manual add (JSON) -- */

/**
 * Container keys the MCP ecosystem uses for the server map.
 *
 * Trae, Cursor, Claude and most others use `mcpServers`; VS Code uses `servers`,
 * OpenCode `mcp`, Zed `context_servers`. A user pasting "the JSON from that other
 * tool" should not have to translate the wrapper, so all four are accepted and
 * the entries are re-encoded in the TARGET's dialect on the way out.
 */
const CONTAINER_KEYS = ['mcpServers', 'servers', 'mcp', 'context_servers'];

function invalidInput(code, error, field, hint) {
  const out = { ok: false, code, error, field };
  if (hint) out.hint = hint;
  return out;
}

/** Does this object look like one MCP server entry rather than a map of them? */
function looksLikeEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return value.command !== undefined
    || value.url !== undefined
    || value.serverUrl !== undefined
    || value.httpUrl !== undefined;
}

/**
 * Parse the JSON a user pastes into "name -> raw entry" pairs.
 *
 * Accepts a string or an already-parsed object, and four shapes:
 *
 *   { "mcpServers": { "<name>": { ... } } }   Trae / Cursor / Claude / Qwen …
 *   { "servers":    { "<name>": { ... } } }   VS Code
 *   { "mcp":        { "<name>": { ... } } }   OpenCode
 *   { "<name>":     { ... } }                 a bare map
 *   { "name": "x", "command": "…" }           a single bare entry
 *
 * The raw entries stay undecoded here: which dialect decodes them depends on the
 * TARGET tool, which is resolved by the caller before anything is written.
 */
export function parseServerConfig(input) {
  let value = input;
  if (typeof value === 'string') {
    const text = value.replace(/^\uFEFF/, '').trim();
    if (!text) return invalidInput('error.input.json', 'the configuration is empty', 'config', 'paste the JSON of the server(s) to add');
    try {
      value = JSON.parse(text);
    } catch (error) {
      return invalidInput('error.input.json', `the configuration is not valid JSON: ${error && error.message ? error.message : error}`, 'config');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalidInput('error.input.json', 'the configuration must be a JSON object', 'config');
  }

  const container = CONTAINER_KEYS.find((key) => {
    const inner = value[key];
    return inner && typeof inner === 'object' && !Array.isArray(inner);
  });
  let entries;
  if (container) {
    entries = Object.entries(value[container]);
  } else if (looksLikeEntry(value)) {
    /* A single bare entry: its `name` is the server name, and the name field must
     * not survive into the dialect encoding as a stray key. */
    const { name: rawName, ...entry } = value;
    const name = String(rawName ?? '').trim();
    if (!name) return invalidInput('error.input.json', 'a single server entry needs a "name"', 'config', 'or wrap it in { "mcpServers": { "<name>": { … } } }');
    entries = [[name, entry]];
  } else if (Object.values(value).some(looksLikeEntry)) {
    entries = Object.entries(value);
  } else {
    return invalidInput(
      'error.input.json',
      'no server entries found in the configuration',
      'config',
      'expected { "mcpServers": { "<name>": { "command": …, "args": […] } } } or { "<name>": { … } }',
    );
  }

  if (entries.length === 0) return invalidInput('error.input.json', 'the configuration declares no servers', 'config');
  const pairs = entries.map(([name, raw]) => ({ name: String(name).trim(), raw }));
  const unnamed = pairs.find((pair) => !pair.name);
  if (unnamed) return invalidInput('error.input.json', 'every server needs a name', 'config');
  return { ok: true, entries: pairs };
}

/**
 * Check one decoded server before it can be written.
 *
 * Decoding already guarantees the shape (a transport, string args, env/header
 * maps), so this is about the things a decoder cannot judge: a stdio entry with
 * no command, a remote entry with a URL that is not http(s), a timeout that is
 * not a usable number. The error names the field so the page can point at it.
 */
function validateDecodedServer(server) {
  if (!server || typeof server !== 'object') return invalidInput('error.input.json', 'the entry is not an object', 'config');
  if (!TRANSPORTS.includes(server.transport)) {
    return invalidInput('error.input.transport', `transport must be one of ${TRANSPORTS.join(', ')}`, 'config');
  }
  if (server.transport === 'stdio') {
    if (!String(server.command ?? '').trim()) {
      return invalidInput('error.input.command', 'a stdio server needs a "command"', 'config', 'add "command": "npx" (plus "args") to the entry, or use a remote "url" instead');
    }
  } else {
    const url = String(server.url ?? '').trim();
    if (!url) return invalidInput('error.input.url', 'a remote server needs a "url"', 'config');
    if (!/^https?:\/\//i.test(url)) return invalidInput('error.input.url', 'the "url" must start with http:// or https://', 'config');
  }
  if (server.timeoutMs !== undefined && (!Number.isFinite(server.timeoutMs) || server.timeoutMs <= 0)) {
    return invalidInput('error.input.timeoutMs', 'the timeout must be a positive number of milliseconds', 'config');
  }
  return { ok: true, server: { ...server, serverName: server.name } };
}

/**
 * Which name, if any, already sits on this target for the definition about to be
 * added.
 *
 * `applyServerToTarget` answers a collision by suffixing the newcomer, which is
 * right when copying an existing server between tools but wrong for a manual
 * add: the user named the server and would silently get `foo-2`. So the add path
 * refuses instead, and the page asks for another name.
 */
function existingTargetName({ store, configEditor, profileDir }, { client, path }, displayName) {
  if (client.managed) {
    const mountName = dshMountName(displayName);
    const row = mcpEntries(configEditor).find((item) => {
      const config = { ...item.inherited, ...item.override };
      return config.serverName === mountName;
    });
    if (row) return { name: mountName, where: 'a DeepSeek Harness row' };
    if (patchHasServer(mountName, profileDir)) return { name: mountName, where: 'the profile patch' };
    return null;
  }
  const key = sanitizeName(displayName);
  const current = store.readFile(path);
  if (!current.ok || current.exists !== true || !current.text.trim()) return null;
  try {
    if (client.format === 'toml') {
      const servers = readTomlServers(current.text);
      return Object.prototype.hasOwnProperty.call(servers, key) ? { name: key, where: path } : null;
    }
    if (client.format !== 'json') return null;
    const container = readContainer(current.text, client.containerKey);
    if (!container.ok) return null; // the write path reports the parse failure itself
    const servers = container.value ?? {};
    return Object.prototype.hasOwnProperty.call(servers, key) ? { name: key, where: path } : null;
  } catch {
    return null;
  }
}

/**
 * Manual add: parse a pasted configuration, then write every entry into one target.
 *
 * Unlike apply/sync — which resolve the definition from the host-side scan so a
 * redacted browser copy can never overwrite a real credential — this path has no
 * scanned source to prefer, and the pasted definition IS the intent. Each entry
 * is decoded through the TARGET's dialect (so a Trae-shaped paste lands correctly
 * in OpenCode, Windsurf, Zed or DeepSeek Harness), checked, then handed to the
 * same guarded write every other mutation uses: backup, compare-and-set against
 * the file hash, ownership ledger and the project-scope credential refusal all
 * apply unchanged.
 *
 * A batch is sequential and carries the hash forward after each write, because
 * writing entry one changes the file and would otherwise make entry two fail the
 * conflict guard against the hash the caller read.
 */
export async function addServers(deps, input = {}) {
  const parsed = input.config !== undefined || input.server === undefined
    ? parseServerConfig(input.config)
    : (() => {
      /* The agent tool and older callers may still pass one canonical server. */
      const server = input.server;
      if (!server || typeof server !== 'object' || !String(server.name ?? '').trim()) {
        return invalidInput('error.input.server', 'server is required', 'config');
      }
      return { ok: true, entries: [{ name: String(server.name).trim(), raw: server }] };
    })();
  if (!parsed.ok) return parsed;

  const target = input.target ?? {};
  const located = locateTarget({
    ...target,
    projectRoots: input.projectRoots ?? target.projectRoots ?? [],
  });
  if (!located.ok) return located;
  const { client, scope, path } = located;

  const results = [];
  let expectedHash = input.expectedHash;
  for (const entry of parsed.entries) {
    const base = { displayName: entry.name };
    /*
     * A file target keys the entry by its name, so the name has to be one the
     * container can hold. `示例服务器` would be sanitized to the constant
     * `server`, and the user would be told it was added while a different key
     * appeared. The Harness maps non-ASCII names deterministically (see
     * `dshMountName`), so there the display name is allowed and the mount name
     * is reported back.
     */
    if (!client.managed && sanitizeName(entry.name) !== entry.name) {
      results.push({
        ok: false,
        ...base,
        code: 'error.input.name',
        error: `“${entry.name}” cannot be used as a name in ${client.id}`,
        hint: 'use 1-32 characters from A-Z a-z 0-9 _ -',
      });
      continue;
    }
    const decoded = decodeEntry(entry.name, entry.raw, client.dialect);
    const checked = validateDecodedServer(decoded);
    if (!checked.ok) {
      results.push({ ok: false, ...base, ...checked });
      continue;
    }
    const taken = existingTargetName(deps, located, checked.server.name);
    if (taken) {
      results.push({
        ok: false,
        ...base,
        code: 'error.server.exists',
        error: `“${taken.name}” already exists in ${taken.where}`,
        hint: 'remove the existing entry first, or use a different name',
      });
      continue;
    }
    const applied = await applyServerToTarget(deps, {
      clientId: client.id,
      scope,
      path,
      server: checked.server,
      expectedHash,
      force: input.force === true,
    });
    if (!applied.ok) {
      results.push({ ok: false, ...base, ...applied });
      continue;
    }
    /* The batch continues against the file this write produced, not the old hash. */
    if (typeof applied.hash === 'string') expectedHash = applied.hash;
    results.push({
      ok: true,
      ...base,
      name: applied.name ?? checked.server.name,
      clientId: client.id,
      scope,
      changed: applied.changed !== false,
      via: applied.via,
      restartRequired: applied.restartRequired,
    });
  }

  const added = results.filter((item) => item.ok);
  const failed = results.filter((item) => !item.ok);
  const summary = {
    ok: added.length > 0,
    added: added.length,
    failed: failed.length,
    clientId: client.id,
    scope,
    results,
  };
  if (added.length === 0) {
    return { ...summary, ...failed[0] };
  }
  return summary;
}

/**
 * Render the file text that would result from placing `server` at `target`.
 * Pure: same inputs, same bytes. Used for both the dry-run preview and the
 * actual write so the preview is never a lie.
 */
export function renderTargetText({ client, text, server, existingName }) {
  const name = existingName ?? server.name;
  const entry = encodeEntry({ ...server, name }, client.dialect);
  if (client.format === 'toml') return writeTomlServer(text, name, entry);
  const written = writeContainerEntry(text, client.containerKey, name, entry);
  if (!written.ok) throw new Error(written.error);
  return written.text;
}

/** Pick the concrete file a `{clientId, scope}` pair maps to. */
export function locateTarget({ clientId, scope, path, projectRoots = [] }) {
  const client = CLIENT_BY_ID.get(clientId);
  if (!client) return { ok: false, code: 'error.target.unknownClient', error: `unknown client ${clientId}` };
  if (!WRITABLE_KINDS.has(client.format) && !client.managed) {
    return { ok: false, code: 'error.target.readOnly', error: `${clientId} is read-only` };
  }
  if (client.readOnly && !client.managed) {
    return { ok: false, code: 'error.target.readOnly', error: `${clientId} is read-only here` };
  }
  if (typeof path === 'string' && path) return { ok: true, client, scope: scope ?? 'global', path };
  /*
   * A managed client (DSH) has no file of its own: its rows live in the profile
   * composition and are addressed through configEditor or the patch layer, so
   * there is a single logical location and no path to resolve.
   */
  if (client.managed) {
    const wanted = scope ?? 'profile';
    if (wanted !== 'profile') return { ok: false, code: 'error.target.noScope', error: `${clientId} only has profile scope` };
    return { ok: true, client, scope: 'profile', path: '(profile composition)' };
  }
  const candidates = resolveClientPaths(client, projectRoots[0]);
  const match = candidates.find((item) => item.scope === (scope ?? 'global'));
  if (!match) return { ok: false, code: 'error.target.noScope', error: `no ${scope} location for ${clientId}` };
  return { ok: true, client, scope: match.scope, path: match.path };
}

/**
 * Write one server into one target.
 *
 * `expectedHash` is required for a safe write: the caller passes the hash it
 * scanned, and a changed file returns 409 instead of clobbering the user's edit.
 */
export async function applyServerToTarget({ store, configEditor, profileDir }, input) {
  const located = locateTarget(input);
  if (!located.ok) return located;
  const { client, scope, path } = located;
  const server = input.server;
  if (!server || typeof server !== 'object') return { ok: false, code: 'error.input.server', error: 'server is required' };

  const secret = hasLiteralSecret(server);
  if (secret && scope === 'project') {
    return {
      ok: false,
      code: 'error.secret.projectScope',
      error: `refusing to write literal ${secret.where} credential ${secret.key} into a project-scope file`,
      hint: 'replace the value with a variable reference, or target the global scope',
    };
  }

  /*
   * A masked definition means the caller handed back the redacted copy the
   * browser holds. Writing it would replace the credential with `••••`, so
   * refuse loudly instead of corrupting a working config.
   */
  const masked = maskedField(server);
  if (masked) {
    return {
      ok: false,
      code: 'error.server.masked',
      error: `refusing to write a masked ${masked.where} value for ${masked.key}`,
      hint: 'the definition must come from the host; reload the state and retry',
    };
  }

  if (client.managed) {
    const rows = mcpEntries(configEditor);
    /*
     * Mount under the name the harness can accept, not the display name: a CJK
     * or spaced name would otherwise be sanitized to a colliding stub. See
     * `dshMountName` for the current value of that mapping and what going
     * through the raw display name broke.
     */
    const targetName = dshMountName(server.serverName ?? server.name);
    const previous = rows.find((row) => {
      const config = { ...row.inherited, ...row.override };
      return config.serverName === targetName;
    }) ?? (input.rowId ? rows.find((row) => row.entry?.id === input.rowId) : undefined);
    /*
     * Two ways a DSH row can come into being, and the right one depends on
     * whether the row already exists: configEditor rewrites a live entry
     * (validated, hot-reloaded), while a brand-new server has no entry to
     * address and must go through the patch layer. Try the row first so the
     * normal case keeps using the validated path.
     */
    if (previous) {
      const result = await upsertDshServer(configEditor, { server: { ...server, serverName: targetName }, previous });
      if (result.ok) store.recordOwnership({ serverName: targetName, displayName: server.serverName ?? server.name, clientId: 'dsh', path: '(profile composition)', scope: 'profile', fingerprint: definitionHash(server) });
      return result;
    }
    const patched = writeDshPatchServer({ server: { ...server, serverName: targetName }, store, profileDir });
    if (patched.ok) {
      store.recordOwnership({ serverName: targetName, displayName: server.serverName ?? server.name, clientId: 'dsh', path: '(profile composition)', scope: 'profile', fingerprint: definitionHash(server) });
      /*
       * The patch layer is only read when the Loader reconciles, so unlike an
       * edit this needs a restart. Say so rather than implying it is live.
       */
      return { ...patched, restartRequired: patched.changed === true, via: 'patch' };
    }
    return patched;
  }

  // Name collision inside the target file.
  const current = store.readFile(path);
  if (!current.ok) return { ok: false, code: 'error.file.read', error: current.error };
  const existing = new Map();
  try {
    if (client.format === 'toml') {
      for (const [key, value] of Object.entries(readTomlServers(current.text))) existing.set(key, value);
    } else {
      const container = readContainer(current.text, client.containerKey);
      if (!container.ok) return { ok: false, code: 'error.file.parse', error: container.error };
      for (const [key, value] of Object.entries(container.value ?? {})) existing.set(key, value);
    }
  } catch (error) {
    return { ok: false, code: 'error.file.parse', error: String(error && error.message ? error.message : error) };
  }

  /*
   * Re-writing a server we already placed must be an in-place update, not a
   * second copy under a suffixed name. So a taken name is still ours to
   * overwrite when either the definition on disk already equals the one we are
   * writing (a repeat apply) or the ledger says we wrote that entry and the
   * user has not edited it since. Only a foreign server sitting on the name
   * gets the suffix treatment, so we never silently clobber someone else's.
   */
  const wanted = sanitizeName(server.serverName ?? server.name);
  const taken = new Set(existing.keys());
  let finalName = wanted;
  if (taken.has(wanted)) {
    const onDisk = decodeEntry(wanted, existing.get(wanted), client.dialect);
    const sameDefinitionAlready = sameDefinition(onDisk, server);
    const owned = store.ownershipOf(wanted)?.targets?.[`${client.id}:${scope}:${path}`];
    const ownedAndUnedited = owned && owned.fingerprint === definitionHash(onDisk);
    if (!sameDefinitionAlready && !ownedAndUnedited) finalName = uniqueName(wanted, taken);
  }

  const result = store.mutate({
    path,
    clientId: client.id,
    scope,
    serverName: finalName,
    expectedHash: input.expectedHash,
    force: input.force === true,
    label: 'apply',
    mutate: (text) => {
      const nextText = renderTargetText({ client, text, server: { ...server, name: finalName }, existingName: finalName });
      return { text: nextText };
    },
  });
  if (!result.ok) return result;
  store.recordOwnership({ serverName: finalName, clientId: client.id, path, scope, fingerprint: definitionHash(server) });
  return { ...result, name: finalName, clientId: client.id, scope };
}

/** Remove one server entry from one target. */
export function removeServerFromTarget({ store, configEditor, profileDir }, input) {
  const located = locateTarget(input);
  if (!located.ok) return located;
  const { client, scope, path } = located;
  const name = input.name;
  if (!name) return { ok: false, code: 'error.input.name', error: 'name is required' };
  if (client.managed) return { ok: false, code: 'error.dsh.useAsync', error: 'DSH removal needs the async path' };
  const result = store.mutate({
    path,
    clientId: client.id,
    scope,
    serverName: name,
    expectedHash: input.expectedHash,
    force: input.force === true,
    label: 'remove',
    mutate: (text) => {
      if (client.format === 'toml') return { text: removeTomlServer(text, name) };
      const removed = removeContainerEntry(text, client.containerKey, name);
      if (!removed.ok) throw new Error(removed.error);
      return { text: removed.text };
    },
  });
  if (result.ok && result.changed) store.forgetOwnership({ serverName: name, clientId: client.id, scope, path });
  return { ...result, clientId: client.id, scope, name };
}

/**
 * Poll until the Loader has stopped reporting a row with this mount name.
 *
 * The mirror of `waitForRow`: a removed patch item is reconciled by the Loader
 * on its own schedule, so the honest answer right after the write is "still
 * activating", not "gone".
 */
async function waitForRowGone(configEditor, name, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const present = mcpEntries(configEditor).some((candidate) => {
      const config = { ...candidate.inherited, ...candidate.override };
      return config.serverName === name;
    });
    if (!present) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Async wrapper so DSH (patch layer) and file targets share one entry point. */
export async function removeServer(deps, input) {
  const located = locateTarget(input);
  if (located.ok && located.client.managed) {
    /*
     * The row is keyed by mount name, so a CJK display name addresses nothing
     * directly. Map it exactly as the write path does, or the removal would
     * report "missing" for a server that is plainly mounted.
     */
    const rowName = input.mountName ? sanitizeName(input.mountName) : dshMountName(input.name);
    const row = mcpEntries(deps.configEditor).find((candidate) => {
      const config = { ...candidate.inherited, ...candidate.override };
      return config.serverName === rowName;
    });
    /*
     * Removal means removing the row's PATCH ITEM — the part this plugin owns.
     *
     * It used to also rewrite the live row through `configEditor.edit` and delete
     * its `serverName`. That cannot work: `configEditor` can edit a row's config
     * but not delete the row, and mcp-client's own schema requires `serverName`,
     * so the edit was rejected ("expected { serverName: string, … }") — the
     * removal reported a failure while the row stayed behind and kept failing to
     * connect. The Loader drops the row once the patch item is gone, which is
     * also exactly how the row came into being.
     */
    const patched = removeDshPatchServer({ serverName: rowName, store: deps.store, profileDir: deps.profileDir });
    if (patched.changed) {
      deps.store.forgetOwnership({ serverName: rowName, clientId: 'dsh', scope: 'profile', path: '(profile composition)' });
      const budget = Number.isFinite(deps.removeWaitMs) ? deps.removeWaitMs : 8000;
      const gone = await waitForRowGone(deps.configEditor, rowName, budget);
      return {
        ok: true,
        changed: true,
        via: 'patch',
        name: input.name,
        mountName: rowName,
        live: gone,
        activating: !gone,
        restartRequired: false,
      };
    }
    if (row) {
      return {
        ok: false,
        code: 'error.dsh.notPatchRow',
        error: `${rowName} is declared by the profile composition, not by this plugin`,
        hint: 'switch it off in the list, or remove its row from the profile composition',
      };
    }
    return { ok: false, code: 'error.dsh.missing', error: `no MCP row named ${input.name}` };
  }
  return removeServerFromTarget(deps, input);
}

/**
 * Copy one server definition to a set of targets, honoring each target's
 * capabilities. Returns per-target results so a partial sync is visible.
 */
export async function syncServer(deps, { server, targets = [], expectedHashes = {}, force = false }) {
  const results = [];
  for (const target of targets) {
    const located = locateTarget(target);
    if (!located.ok) { results.push({ target, ...located }); continue; }
    const dropped = [];
    const shaped = { ...server };
    for (const [field, supported] of Object.entries(located.client.caps ?? {})) {
      if (supported) continue;
      if (field === 'timeoutMs' && shaped.timeoutMs !== undefined) { delete shaped.timeoutMs; dropped.push('timeoutMs'); }
      if (field === 'autoApprove' && shaped.autoApprove !== undefined) { shaped.autoApprove = []; dropped.push('autoApprove'); }
      if (field === 'envFile') continue;
    }
    if (located.client.transportLimit && !located.client.transportLimit.includes(shaped.transport)) {
      results.push({ target, ok: false, code: 'error.target.transport', error: `${located.client.id} cannot express ${shaped.transport}` });
      continue;
    }
    const expectedHash = expectedHashes[`${target.clientId}:${target.scope}:${target.path}`] ?? expectedHashes[`${target.clientId}:${target.scope}`];
    const result = await applyServerToTarget(deps, { ...target, server: shaped, expectedHash, force });
    results.push({ target, ...result, droppedFields: dropped });
  }
  return { ok: results.every((item) => item.ok), results };
}

/** A YAML patch snippet for adding a brand-new DSH row. */
export function snippetFor(server) {
  return dshSnippet(server);
}

export { decodeEntry };
