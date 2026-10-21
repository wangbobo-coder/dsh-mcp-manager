/**
 * Mount / unmount one MCP server in DeepSeek Harness.
 *
 * The switch is deliberately NOT a `enabled: false` field written into a client
 * config file. Two reasons, both load-bearing:
 *
 *   1. Most clients have no such field. Qoder's mcp.json and Trae's mcp.json
 *      carry no enable-ish key at all. Writing one would mean writing a key the
 *      tool ignores — a switch that lies.
 *   2. The user was explicit that the switch must not disturb the original
 *      directories or their tools. So the only file this ever edits is OUR OWN
 *      profile composition.
 *
 * What a switch actually does, by case:
 *
 *   live row   — `pluginManager.setPluginEnabled(rowId, enabled)`. The Loader
 *                disposes the mcp-client instance, so its tools leave the tool
 *                list, and re-enabling re-inits it. Hot, no restart.
 *   patch row  — the server exists only as an `- insert:` item that has not
 *                mounted yet (or mounted in a composition we cannot address).
 *                We append/remove the same `- id: <patchId> / disabled: true`
 *                override the plugin manager writes, so the definition stays
 *                byte-identical and re-enabling restores the file exactly.
 *   other file — refused. Toggling there would edit the other tool's config.
 */
import { setDshPatchDisabled, removeDshPatchServer, readDshPatchServers } from './dsh-patch.js';
import { dshMountName, sanitizeName } from './canonical.js';

function pluginManagerOf(get) {
  if (typeof get !== 'function') return undefined;
  try {
    return get('pluginManager');
  } catch {
    return undefined;
  }
}

/** Did *this plugin* write the row for this server, rather than the user? */
function ownedByUs(store, name) {
  if (!store || typeof store.ownershipOf !== 'function') return false;
  try {
    const bucket = store.ownershipOf(name);
    return Boolean(bucket && bucket.targets && bucket.targets['dsh:profile:(profile composition)']);
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<{ok:boolean, changed?:boolean, enabled?:boolean,
 *   via?:'loader'|'patch', restartRequired?:boolean, target?:string,
 *   code?:string, error?:string, hint?:string}>}
 */
export async function toggleServer({ get, profileDir, store }, { name, enabled, entryId, mountName }) {
  if (!name) return { ok: false, code: 'error.input', error: 'name is required' };
  if (typeof enabled !== 'boolean') return { ok: false, code: 'error.input', error: 'enabled must be a boolean' };

  /*
   * The row in the composition is keyed by the MOUNT name, not the display
   * name, and the two differ whenever the harness cannot accept the display
   * name verbatim (`serverName` is `[A-Za-z0-9_-]{1,32}`). Addressing the row by
   * the display name found nothing, so the switch fell through to the patch
   * layer and demanded a restart for a server it had just mounted. Accept the
   * scan's `mountName` when given and otherwise derive the same mapping.
   */
  const rowName = mountName ? sanitizeName(mountName) : dshMountName(name);

  const manager = pluginManagerOf(get);

  /*
   * Unmounting a row WE created takes our own row out again.
   *
   * This runs first, before the Loader path and before the manager check, for
   * three reasons: the Loader disposes the instance hot but does so by appending
   * a `disabled: true` override beside the `- insert:` item, which leaves our
   * row (and the override) in the user's composition forever; removing the
   * insert item returns the file to exactly the bytes it had before we mounted
   * anything; and removing a row needs no service, so the switch still works if
   * the plugin manager is unavailable. A row the user authored is never touched
   * here — `ownedByUs` requires our own ledger entry for it.
   */
  if (!enabled && ownedByUs(store, rowName)) {
    const removed = removeDshPatchServer({ serverName: rowName, store, profileDir });
    if (removed.ok && removed.changed) {
      return { ok: true, changed: true, enabled: false, via: 'patch', restartRequired: false, target: removed.path, unmounted: true };
    }
  }

  if (!manager) {
    /*
     * No plugin manager: a row we can reach in the patch layer can still be
     * switched with an override item, but a live Loader row cannot be addressed
     * at all. Try the patch layer, and only refuse if there is nothing there.
     */
    const pending = readDshPatchServers(profileDir).find((item) => item.name === rowName);
    if (pending) {
      const patched = setDshPatchDisabled({ serverName: rowName, disabled: !enabled, store, profileDir });
      if (patched.ok) {
        return { ok: true, changed: patched.changed === true, enabled, via: 'patch', restartRequired: patched.changed === true, target: patched.path };
      }
    }
    return {
      ok: false,
      code: 'error.toggle.noManager',
      error: 'the plugin manager service is not available, so a live row cannot be mounted or unmounted',
      hint: 'this switch only mounts servers in DeepSeek Harness; without the plugin manager there is nothing to switch',
    };
  }

  /*
   * Address the row by entryId when the scan supplied one. Falling back to the
   * `mcp-<serverName>` convention covers rows created from our patch layer,
   * whose Loader id we chose ourselves; a row the user authored is addressed by
   * the id the scan read off the tree, never guessed.
   *
   * The `include:` spelling is not decoration: `configEditor.configuration()`
   * lists only rows that were already in the composition, so a server we just
   * inserted into cordis.patch.yml has NO entryId in the scan even after the
   * Loader reconciled it — yet the Loader addresses it as `include:mcp-<name>`
   * (that is the id the bundle patch writes). Without this candidate every
   * unmount of a row we created would fall through to the patch layer, which
   * needs a restart, when the plugin manager could have disposed the instance
   * hot. Tried after the real entryId and before the bare patch id, so an id
   * read off the tree always wins.
   */
  const candidates = [entryId, `include:mcp-${rowName}`, `mcp-${rowName}`]
    .filter((value, index, list) => value && list.indexOf(value) === index);

  let lastError;
  for (const id of candidates) {
    try {
      const result = await manager.setPluginEnabled(id, enabled);
      if (result && result.application === 'failed') {
        lastError = result.error ?? { code: 'error.toggle.failed', error: `plugin manager failed to ${enabled ? 'enable' : 'disable'} ${id}` };
        continue;
      }
      return {
        ok: true,
        changed: result?.changed === true,
        enabled,
        via: 'loader',
        restartRequired: result?.application === 'restart-required',
        target: id,
        overridden: result?.application === 'overridden',
      };
    } catch (error) {
      lastError = { code: 'error.toggle.failed', error: String(error && error.message ? error.message : error) };
    }
  }

  /*
   * No live row answered. Either the server is only an insert item we have not
   * reconciled yet, or it is not mounted here at all.
   */
  const pending = readDshPatchServers(profileDir).find((item) => item.name === rowName);

  if (!pending) {
    /*
     * Not mounted and not pending. Turning the switch off is then already true;
     * turning it on has nothing to mount. Say so instead of writing a
     * `disabled: true` override for a row that does not exist — that override
     * would dangle in the user's composition forever.
     */
    if (!enabled) {
      return { ok: true, changed: false, enabled: false, notMounted: true, via: 'none', restartRequired: false, target: null };
    }
    return {
      ok: false,
      code: 'error.toggle.notMounted',
      error: lastError?.error ?? `no mounted row and no patch row for ${name}`,
      hint: 'this server is defined in another tool only; its switch appears once it is mounted in DeepSeek Harness',
    };
  }

  /*
   * A row we did not create stays in place: it is someone's authored definition,
   * so the switch flips it with the same `disabled: true` override item the
   * plugin manager itself would write, keeping the definition byte-identical.
   * (Our own rows were already removed above.)
   */
  const patched = setDshPatchDisabled({ serverName: rowName, disabled: !enabled, store, profileDir });
  if (patched.ok) {
    return { ok: true, changed: patched.changed === true, enabled, via: 'patch', restartRequired: patched.changed === true, target: patched.path };
  }

  return {
    ok: false,
    // A stable code the UI can key on; the manager's own reason rides along in
    // `error` so a real failure is never hidden behind the generic one.
    code: 'error.toggle.notMounted',
    error: lastError?.error ?? `no mounted row and no patch row for ${name}`,
    hint: 'this server is defined in another tool only; its switch appears once it is mounted in DeepSeek Harness',
  };
}
