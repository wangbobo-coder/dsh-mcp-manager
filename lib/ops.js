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
import { decodeEntry, definitionHash, dshMountName, encodeEntry, isSecretKey, isSecretValue, isMaskedValue, isReferenceValue, secretArgs, sameDefinition, sanitizeName, uniqueName } from './canonical.js';
import { readContainer, removeContainerEntry, writeContainerEntry, readTomlServers, writeTomlServer, removeTomlServer } from './surgical.js';
import { dshSnippet, mcpEntries, upsertDshServer, removeDshServer } from './dsh.js';
import { writeDshPatchServer, removeDshPatchServer } from './dsh-patch.js';

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

/** Async wrapper so DSH (configEditor) and file targets share one entry point. */
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
     * A server may exist as a patch-layer insert (never reconciled into a live
     * entry) or as a live row. Try both rather than reporting "missing" for one
     * that is only in the patch layer.
     */
    if (row) {
      const result = await removeDshServer(deps.configEditor, row);
      const patched = removeDshPatchServer({ serverName: rowName, store: deps.store, profileDir: deps.profileDir });
      if (result.ok) deps.store.forgetOwnership({ serverName: rowName, clientId: 'dsh', scope: 'profile', path: '(profile composition)' });
      return { ...result, ...(patched.changed ? { alsoRemovedFromPatch: true, restartRequired: true } : {}) };
    }
    const patched = removeDshPatchServer({ serverName: rowName, store: deps.store, profileDir: deps.profileDir });
    if (patched.changed) {
      deps.store.forgetOwnership({ serverName: rowName, clientId: 'dsh', scope: 'profile', path: '(profile composition)' });
      return { ...patched, restartRequired: true, via: 'patch' };
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
