# @oh-agent/dsh-mcp-manager

English · [中文](README.md)

Management page for the MCP servers scattered across every local AI development
tool — one card per configuration file showing what it declares, one switch per
server that mounts it in DeepSeek Harness, and one probe of what actually
answers.

DeepSeek Harness → **Settings → MCP Manager** (between Skills Manager and
Market).

## Install

Install the bundle from the **Plugin Manager** page in Settings, or point
`plugin_manager` at the npm package:

```
plugin_manager  action: install_bundle  target: "@oh-agent/dsh-mcp-manager@0.1.3"
```

An absolute directory works as `target` too, which is how you install a local
checkout or the `dsh-mcp-manager.tgz` attached to the
[v0.1.3 release](https://github.com/wangbobo-coder/dsh-mcp-manager/releases).

Do not `pnpm add` the package into the profile by hand, and do not edit the
profile's `package.json` or `cordis.patch.yml`: installing a package is not the
same as selecting its bundle, so doing it manually leaves the row present but
never mounted.

Either way the bundle adds one settings tab and one agent tool (`mcp_manage`);
it declares no runtime dependencies, so there is nothing to build and no
`allowBuilds` step.

The page reads other tools' configuration files but never needs write access to
them for the switch. Nothing leaves the machine — the only outbound traffic is a
probe you ask for, and only to the server you asked about.

## The problem it solves

An MCP server is declared in a different file, under a different key, in a
different dialect for every tool:

| tool | file (Windows) | top-level key |
| --- | --- | --- |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| Claude Code | `~/.claude.json`, `<proj>/.mcp.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| VS Code | `<ws>/.vscode/mcp.json` | `servers` |
| Roo Code | `…\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json` | `mcpServers` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers` |
| Qwen Code | `~/.qwen/settings.json` | `mcpServers` |
| Qoder IDE | `%APPDATA%\Qoder\SharedClientCache\mcp.json` | `mcpServers` |
| OpenCode | `~/.config/opencode/opencode.json` | `mcp` |
| Trae | `%APPDATA%\Trae\User\mcp.json` | `mcpServers` |
| Trae CN | `%APPDATA%\Trae CN\User\mcp.json` | `mcpServers` |
| Copilot CLI | `~/.copilot/mcp-config.json` | `mcpServers` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers` |
| Zed | `settings.json` | `context_servers` |
| Continue | `~/.continue/config.yaml` | `mcpServers` (YAML array) |
| CodeBuddy | `%APPDATA%\CodeBuddy\...` | `mcpServers` |
| **DeepSeek Harness** | profile composition | `@deepseek-ai/dsh-mcp-client` rows |

The differences are not cosmetic and they are where hand-editing goes wrong:

- **Remote transport is spelled differently.** Windsurf only accepts
  `serverUrl` — a `url` key is silently ignored. Gemini and Qwen distinguish
  `url` (SSE) from `httpUrl` (streamable HTTP), while Roo spells streamable
  HTTP `streamable-http`.
- **Timeouts change unit.** Millisecond fields in Gemini/Qwen/DSH, seconds in
  Roo.
- **Commands differ in shape.** OpenCode takes `command` as an array and `env`
  as `environment`; everything else takes a string plus a separate `args`.
- **Some files are shared with unrelated state.** `~/.claude.json` also holds
  history and OAuth tokens; `opencode.json` holds providers and plugins. A
  whole-file rewrite destroys them.

This plugin reads all of it into one model and writes back only the entry it
means to change.

### Windows and macOS

Nothing is hard-coded to one platform. Each adapter declares its file through a
resolver that reads the OS at module load:

| root | Windows | macOS |
| --- | --- | --- |
| `appData()` | `%APPDATA%` | `~/Library/Application Support` |
| `xdgConfig()` | `~/.config` | `~/.config` |
| `vscodeUserDir()` | `%APPDATA%\Code\User` | `~/Library/Application Support/Code/User` |
| `zedConfig()` | `%APPDATA%\Zed` | `~/.config/zed` |
| `HOME`-relative | `~/.codex`, `~/.cursor`, … | identical |

Zed is the exception worth naming: on macOS it reads `~/.config/zed`, **not**
Application Support, so it gets its own resolver. `APPDATA`, `XDG_CONFIG_HOME`
and `COPILOT_HOME` are honoured when set.
Project-scope paths are always joined onto the workspace root, so they are
portable by construction. `scripts/test-paths.mjs` loads the real adapter source
under a simulated `win32`, `darwin` and `linux` and asserts the resolved
directory for every client.

The file table above is written the way Windows shows it (`%APPDATA%`, `\`); on
macOS the same rows resolve under `~/Library/Application Support/`. The scanner
reports the real absolute path it found, so the page always shows the truth for
the machine it is running on.

## Architecture

```
client.js  (settings page)          index.js  (host entry)
        │                                  │
        └──────── /api/dsh-mcp-manager ────┘
                    │         │
              scan.js     ops.js      probe.js
                 │          │            │
           adapters.js  store.js    surgical.js
                 │          │            │
           canonical.js  ledger+     byte-preserving
          (one model)    backups      JSON/TOML/YAML
                             │
                    dsh.js + dsh-patch.js + toggle.js
```

- **`canonical.js` — the single semantic model.** Every client entry decodes to
  `{name, transport, command, args, env, url, headers, timeoutMs, enabled,
  autoApprove, extra, secrets}`. Capabilities are *not* flattened to the lowest
  common denominator: a field a client cannot express is dropped on write and
  reported as `droppedFields`, never silently invented.
- **`adapters.js` — the only format-aware layer.** Eighteen clients described as
  data: container key, dialect (which key means url, which type strings map to
  which transport, timeout unit), capabilities, and where the file lives.
- **`surgical.js` — byte-preserving editors.** Offset-carrying parse trees and
  bottom-up edits, so an entry can be replaced without reformatting the file.
  Comments, trailing commas, CRLF, and unrelated keys survive; unparsable input
  is refused rather than rewritten.
- **`store.js` — the safety net.** A backup of the pre-write bytes, a
  compare-and-set hash check, and an ownership ledger.
- **`probe.js` — does it actually work.** A hand-written JSON-RPC client (no
  dependency on `@modelcontextprotocol/sdk`): spawn stdio → `initialize` →
  `notifications/initialized` → `tools/list`; for remote, POST with
  `Accept: application/json, text/event-stream` and follow an SSE response.
  Read-only — it never invokes a tool.
- **`dsh.js` / `dsh-patch.js` / `toggle.js` — Harness itself as a first-class
  target.** Existing rows are rewritten through `configEditor.edit()` (validated,
  hot-reloaded). A brand-new server has no row to address, so it goes into the
  composition's `- insert:` patch layer, where the Loader picks it up on its own
  — the operation waits for that row and reports `live: true`.
  If the budget expires first it reports `activating: true`, **never** "restart
  required": a patch row is only written where the Loader can see it, so it always
  arrives eventually, and telling the user to restart for a server that is already
  coming up was measured to be wrong here (mounting several servers back to back
  pushed reconciliation past any fixed budget, then all of them appeared live).
  `toggle.js` is the mount switch: a live row goes through
  `pluginManager.setPluginEnabled`, an unmounted one gets the same
  `disabled: true` override item the plugin manager writes, and a server that
  lives only in another tool is first written to the patch layer.

  Discovery reads `entry.options.name`, not `entry.name`: a live Loader entry
  has no `name` property of its own (verified against a running Host), and
  checking the wrong field silently matches zero rows — which made every mounted
  server look unreconciled and demand a restart that was never required.

## Safety model

The write path is built around one rule: **only rewrite what we can prove we
wrote.**

1. **Ownership ledger.** Every write records
   `{path, serverName, fingerprint}`. A later write of the same name is applied
   only if the definition on disk still matches the fingerprint — the user has
   not edited it in the meantime.
2. **A foreign server is never clobbered.** A name already taken by an entry we
   did not write is treated as the user's: the incoming server gets a suffixed
   name instead.
3. **Optimistic concurrency.** The caller passes the hash it scanned; a changed
   file returns `409` with the current hash, and the UI offers a re-scan. Silent
   last-write-wins is not possible.
4. **Backup before every mutation**, retained per the `backupsToKeep` config,
   restorable from the page.
5. **Atomic replace.** Write a temp file, `rename` over the target, then read
   back and re-parse to prove the result is valid.
6. **Credentials are masked before they leave the host.** Masking is
   key-driven, not value-driven — a short token (`TOKEN=abc`) is still masked,
   while an indirection (`${FIGMA_API_KEY}`) is shown as-is because it names a
   secret rather than carrying one. It covers every place a literal hides: env,
   headers, unmodelled `extra`, the raw entry copy, and command-line flags
   (`--figma-api-key=figd_…`, which is the documented invocation for several
   servers and is not an `env` entry at all). `reveal` is an explicit,
   confirmed action.
7. **Literal credentials are refused in project scope.** Writing a plaintext
   key into a file destined for a repository fails with a hint to use an
   environment reference.
8. **A masked definition can never be written back.** The browser only holds
   the redacted copy, so every write resolves the definition from the host-side
   scan; if a mask (`figd••••0000`) still reaches a write path it is refused
   with `error.server.masked` instead of replacing a real credential with
   bullets.
9. **Mutation requests need a custom header** (`x-dsh-mcp-manager: 1`) on top
   of the JSON content-type and the loopback-origin check — a cross-site form
   cannot set it.

## The switch mounts into DeepSeek Harness — and nothing else

The one control on each row is a switch, and it has exactly one meaning: **is
this server mounted in DeepSeek Harness?**

Turning it on mounts the server here. Turning it off unmounts it. The file the
definition came from is never opened for writing by the switch — verified by
hashing every client config before and after a mount/unmount cycle on this
machine, all unchanged.

That restriction is not squeamishness, it is what the formats force. Most clients
have no enable field at all: Qoder's and Trae's `mcp.json` carry no enable-ish key
whatsoever. Writing one would be a switch that lies.

How the mount works, by case:

| the server is | the switch does | takes effect |
| --- | --- | --- |
| an `- insert:` item we wrote | deletes the item on off, rewrites it on on | on reconcile; the file returns to its exact previous bytes |
| already a live `dsh-mcp-client` row | `pluginManager.setPluginEnabled(rowId, …)` | instantly — the row unmounts and its tools leave the tool list |
| an `- insert:` item the user wrote | appends/removes the same `- id: …` / `disabled: true` override the plugin manager itself writes | on reconcile |
| declared in another tool only, and switched on | writes a new `- insert:` row | live as soon as the Loader reconciles it (usually 1–4 s); the operation waits up to 8 s and reports `live: true`, else `activating: true` |
| not mounted anywhere, and switched off | nothing — already true, no dangling override | — |

Our own row is removed before the Loader path is tried: the plugin manager can
dispose a row hot, but it does so by appending a `disabled: true` override beside
the definition, which would leave both our row and that override in the user's
composition permanently. Removing the insert item is both the unmount and the
cleanup.

Because the override is a separate item and not a rewrite, and because a row we
wrote is removed rather than disabled, a full mount → unmount cycle returns
`cordis.patch.yml` to its exact previous bytes.

### A mount name is not always the display name

`@deepseek-ai/dsh-mcp-client` requires `serverName` to match
`/^[A-Za-z0-9_-]{1,32}$/`. Many real servers do not — Chinese names commonly look
like `示例服务器 - API 文档`, and an English name like `My Bridge` carries a space.
Squeezing those through `sanitizeName` alone gives `API` for every Chinese name,
so a second mount would collide with the first and the switch would flip the wrong
server.

`canonical.js` therefore exports `dshMountName(name)`: sanitize, and if the result
lost information (CJK characters, spaces, over-length) append a short hash of the
original — `示例服务器 - API 文档` → `API-0aac0ee2`, `My Bridge` →
`My-Bridge`. It is pure and total, so the write path, the scan, the toggle
and the removal all compute the same string from the same input without storing a
mapping anywhere.

Consequences the scan and the page handle:

- the node keeps its display name; `mountedAs` carries the row name and `entryId`
  the Loader id, so the switch finds its row under the mapped name;
- the server appears under the DSH file card with its display name, and the
  original tools' cards are unchanged;
- two servers that sanitize to the same base still get distinct row names (the
  hash differs), so no server silently replaces another.

`scripts/test-mount-name.mjs` pins the mapping, including the collision case and
the round trip through scan.

## Using it

The page is laid out like the skills page it sits next to: a title row with the
actions, a four-cell summary strip (servers · files · mounted in DSH · literal
credentials), a filter row, then one bordered card per config file.

Each card lists the servers that file declares — headed by the tool name, the
server count and the path (shortened to `%APPDATA%\…` style, full path in the
tooltip). A card collapses; while a filter is active every card opens, because a
match hidden inside a collapsed card reads as "no results". Every row shows the
transport, the command or URL, how many tools share the definition, its probe
result, and the mount switch.

The filters are a free-text search (name, command, path) plus two selects: by
tool, and by mount state (mounted / not mounted).

Clicking a row opens a dialog rather than expanding it in place — inline
expansion reflows every row below and made the card look like two stacked cards.
The dialog lists every file that declares the server, the canonical definition,
a paste-ready YAML row for a cordis composition, and "copy to…" for pushing the
definition into another tool.

The same operations are exposed to the agent as the `mcp_manage` tool, so the
page and the agent share one implementation and cannot diverge:

```
action: scan | probe | toggle | apply | remove | sync | snippet | reveal | history
```

## Configuration

`cordis.patch.yml` row config:

| key | default | meaning |
| --- | --- | --- |
| `includeProjectScope` | `true` | also scan workspace-level files |
| `probeTimeoutMs` | `20000` | per-server probe budget |
| `probeConcurrency` | `4` | parallel probes |
| `backupsToKeep` | `20` | retained backups per file |

State (ledger + backups) lives in `<DSH_HOME>/mcp-manager/`.

## Verified on this machine

Eight of eighteen clients installed, 27 servers discovered across Qoder IDE,
OpenCode, Trae, Trae CN and DSH. Context7 probes OK with 2 tools,
`playwright_mcp` with 25. A DSH server mounted and unmounted through the page
leaves `cordis.patch.yml` **byte-identical** to its pre-write hash, with the
user's own provider, permission and agency entries untouched — and every other
client configuration file keeps its hash through the same cycle.

Twenty-one plaintext credentials were found on disk — most in `env` maps and
one in a command-line flag (`--figma-api-key` in Qoder's `mcp.json`). None of
their literals appears anywhere in the state payload; the page shows only key
names, and the write path refuses a masked value.

Thirteen test suites under `scripts/` cover the editors, the path layer, the write
path, the DSH adapter, the patch layer, the mount switch, the mount-name mapping
for non-ASCII server names, redaction and the masked-write guard, plus an
end-to-end pass that asserts no credential literal reaches the client payload:

```
node scripts/test-surgical.mjs      17 passing
node scripts/test-write.mjs         12 passing
node scripts/test-dsh.mjs           16 passing
node scripts/test-dsh-patch.mjs     15 passing
node scripts/test-dsh-e2e.mjs        8 passing
node scripts/test-toggle.mjs        16 passing
node scripts/test-redact.mjs        14 passing
node scripts/test-masked-write.mjs   5 passing
node scripts/test-client-load.mjs   28 passing
node scripts/test-paths.mjs         16 passing
node scripts/test-mount-name.mjs    12 passing
node scripts/test-locale.mjs         en/zh key parity
node scripts/test-release.mjs        11 passing
```

## Known limits

- **Install detection is file presence.** An installed tool with no MCP config
  yet is indistinguishable from an absent one until its directory exists.
- **A newly mounted DSH server relies on the Loader reconciling it.** The
  operation waits up to 8 s for the row and reports `live: true`; if that window
  expires it reports `activating: true` and the page re-reads the state a moment
  later. No restart is ever demanded for a row the Loader can see.
- **A row we did not write is switched off, not removed.** Deleting a definition
  the user pasted would destroy their work, so such a row gets the same
  `disabled: true` override the plugin manager writes, and stays in the file.
- **Only DSH is switchable.** The other tools' files are read and written
  explicitly, never toggled — see the section above.
- **Continue is read-only** (YAML array shape); editing it is planned.
- **Secrets are not migrated to a vault.** The plugin masks and warns; moving
  credentials into `${env:...}` references stays the user's decision.
- **The MCP registry is not consulted.** `registry.modelcontextprotocol.io` is
  explicitly preview and not intended for direct host consumption, so server
  discovery is by scanning local files only.

## Licence

MIT
