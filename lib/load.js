/**
 * Runtime load status: did a mounted MCP server actually CONNECT?
 *
 * A row in the profile composition only proves a server is MOUNTED. It says
 * nothing about whether the connection succeeded, because `@deepseek-ai/dsh-mcp-client`
 * treats a failed first connection as a non-event: `apply()` awaits
 * `connection.ready` and, when `failOnStartupError` is false (the default), it
 * merely returns on error. The fiber stays `active`, the plugin manager reports
 * `fiberPhase: 'active'`, and the settings file still lists the server — so
 * "mounted but broken" is invisible everywhere the UI used to look.
 *
 * The one place a successful connection MUST leave a trace is the tool
 * registry: every tool of a connected server is registered as
 * `mcp__<serverName>__<rawName>`. That makes the registry the ground truth, and
 * this module only ever READS it — it spawns nothing and writes nothing.
 *
 * Limitation worth stating plainly: a server that connects successfully but
 * declares zero tools also registers zero names, so it is indistinguishable
 * from a failed connection here. The status message says so instead of
 * pretending to know which one it is, and `probe` answers the question.
 */

const PREFIX = 'mcp__';

/**
 * Read the live tool names out of the registry.
 *
 * Returns `null` — never an empty array — when the registry is unavailable, so
 * a profile without the `tools` service reports "unknown" rather than accusing
 * every server of having failed.
 */
export function liveToolNames(tools) {
  if (!tools || typeof tools.schemas !== 'function') return null;
  try {
    const schemas = tools.schemas();
    if (!Array.isArray(schemas)) return null;
    return schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string');
  } catch {
    return null;
  }
}

/**
 * Count registered tools per mounted server name.
 *
 * Matched by longest known mount name rather than by splitting on `__`, because
 * `serverName` legitimately allows underscores: for a server named `a__b` the
 * naive split of `mcp__a__b__tool` would credit server `a`. Only the mount
 * names we actually asked about can match, so longest-first is unambiguous.
 */
export function indexLiveTools(toolNames, mountNames) {
  const counts = new Map();
  if (!Array.isArray(toolNames) || !toolNames.length) return counts;
  const ordered = [...mountNames].filter((name) => typeof name === 'string' && name).sort((left, right) => right.length - left.length);
  if (ordered.length === 0) return counts;
  for (const name of toolNames) {
    if (typeof name !== 'string' || !name.startsWith(PREFIX)) continue;
    const hit = ordered.find((mount) => name.startsWith(`${PREFIX}${mount}__`));
    if (!hit) continue;
    counts.set(hit, (counts.get(hit) ?? 0) + 1);
  }
  return counts;
}

/** Count the registered tools of one mount name. */
export function countLiveTools(toolNames, mountName) {
  if (!Array.isArray(toolNames) || typeof mountName !== 'string' || !mountName) return 0;
  const prefix = `${PREFIX}${mountName}__`;
  let total = 0;
  for (const name of toolNames) if (typeof name === 'string' && name.startsWith(prefix)) total += 1;
  return total;
}

/**
 * Turn the observations into one status.
 *
 *   absent  — not mounted in DeepSeek Harness at all
 *   off     — mounted but disabled, so nothing is expected to run
 *   pending — a patch row the Loader has not reconciled yet
 *   loaded  — mounted, enabled, and at least one tool is registered
 *   failed  — mounted and enabled, yet no tool is registered
 *   unknown — the tool registry is unavailable, so nothing can be claimed
 */
export function loadStatus({ mounted, enabled, pending, toolCount }) {
  if (!mounted) return 'absent';
  if (enabled === false) return 'off';
  if (pending === true) return 'pending';
  if (toolCount === null || toolCount === undefined) return 'unknown';
  return toolCount > 0 ? 'loaded' : 'failed';
}

/** Build one `load` record for a mount name. */
export function loadRecord({ mountName, mounted, enabled, pending, counts, registry }) {
  const toolCount = counts ? (mountName ? counts.get(mountName) ?? 0 : 0) : null;
  const status = loadStatus({ mounted, enabled, pending, toolCount });
  return { mountName: mountName ?? null, status, toolCount: toolCount ?? 0, registry: registry === true };
}

/** True when this status is something the user must act on. */
export function needsAttention(status) {
  return status === 'failed';
}
