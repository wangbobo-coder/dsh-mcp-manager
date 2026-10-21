/**
 * Client adapters: where each tool stores MCP servers, in what format, and how
 * its dialect differs from the canonical model.
 *
 * A row here is a declaration, not code. The scanner and the writer are generic
 * and driven entirely by these declarations, so adding a client is a data edit.
 * Every path is resolved per (os, client, scope); nothing is built by string
 * concatenating `~`, because the real paths disagree more than they match
 * (`%APPDATA%\Trae\User\mcp.json`, Roo's `rooveterinaryinc.roo-cline` directory
 * holding `cline_mcp_settings.json`, Qoder's IDE cache vs its CLI settings).
 *
 * `caps` states honestly what a client can express. The UI greys out what a
 * target cannot represent instead of silently dropping the field.
 */

import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const IS_WIN = osPlatform() === 'win32';
const IS_MAC = osPlatform() === 'darwin';

function appData(...parts) {
  if (IS_WIN) return join(process.env.APPDATA ?? join(HOME, 'AppData', 'Roaming'), ...parts);
  if (IS_MAC) return join(HOME, 'Library', 'Application Support', ...parts);
  return join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), ...parts);
}

function xdgConfig(...parts) {
  if (IS_WIN) return join(HOME, '.config', ...parts);
  if (IS_MAC) return join(HOME, '.config', ...parts);
  return join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), ...parts);
}

function vscodeUserDir() {
  if (IS_WIN) return appData('Code', 'User');
  if (IS_MAC) return join(HOME, 'Library', 'Application Support', 'Code', 'User');
  return join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), 'Code', 'User');
}

/**
 * Zed is the one client whose config does NOT live in the macOS Application
 * Support directory: it uses `~/.config/zed` on macOS *and* Linux (honouring
 * XDG_CONFIG_HOME), and `%APPDATA%\Zed` on Windows. Sending it through
 * `appData()` would point macOS users at a directory Zed never reads.
 */
function zedConfig(...parts) {
  if (IS_WIN) return appData('Zed', ...parts);
  return join(process.env.XDG_CONFIG_HOME ?? join(HOME, '.config'), 'zed', ...parts);
}

const STDIO_CAPS = { enabled: true, autoApprove: false, timeoutMs: false, envFile: false, oauth: false, projectScope: false };

/** Transport→type spellings per family, both directions. */
const TYPE = {
  claudeCode: {
    typeMap: { stdio: 'stdio', http: 'http-stream', 'streamable-http': 'http-stream', 'streamablehttp': 'http-stream', sse: 'http-sse', ws: 'http-stream', sdk: 'http-stream' },
    reverseType: { stdio: 'stdio', 'http-stream': 'http', 'http-sse': 'sse' },
    typeRequired: true,
    stdioType: 'stdio',
  },
  vscode: {
    typeMap: { stdio: 'stdio', http: 'http-stream', 'streamable-http': 'http-stream', sse: 'http-sse' },
    reverseType: { stdio: 'stdio', 'http-stream': 'http', 'http-sse': 'sse' },
  },
  cursor: { typeMap: { stdio: 'stdio', sse: 'http-sse' }, reverseType: { sse: 'sse' } },
  roo: {
    typeMap: { stdio: 'stdio', 'streamable-http': 'http-stream', sse: 'http-sse' },
    reverseType: { 'http-stream': 'streamable-http', 'http-sse': 'sse' },
  },
  gemini: {
    typeMap: {},
    urlKey: 'httpUrl',
    // `httpUrl` means streamable HTTP; plain `url` means SSE.
    sseUrlKey: 'url',
    reverseType: undefined,
  },
  opencode: {
    typeMap: { local: 'stdio', remote: 'http-stream' },
    reverseType: { stdio: 'local', 'http-stream': 'remote', 'http-sse': 'remote' },
    envKey: 'environment',
    commandArray: true,
    enabledField: 'enabled',
  },
  zed: { typeMap: {} },
  continueLike: { typeMap: {} },
  plain: { typeMap: {} },
};

/**
 * The catalog. `order` decides UI grouping (installed/used clients first).
 * `caps.projectScope` marks clients whose project-level file exists.
 */
export const CLIENTS = [
  {
    id: 'qoder-ide',
    label: { en: 'Qoder (IDE)', zh: 'Qoder（IDE）' },
    order: 20,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.claudeCode,
    caps: { ...STDIO_CAPS, timeoutMs: true },
    note: { en: 'IDE cache file; six-value type enum including sdk/ws.', zh: 'IDE 缓存文件；type 为六值枚举（含 sdk/ws）。' },
    paths: () => [{ scope: 'global', path: appData('Qoder', 'SharedClientCache', 'mcp.json') }],
  },
  {
    id: 'opencode',
    label: { en: 'OpenCode', zh: 'OpenCode' },
    order: 30,
    format: 'json',
    containerKey: 'mcp',
    dialect: TYPE.opencode,
    caps: { ...STDIO_CAPS, enabled: true, projectScope: true },
    note: { en: '`command` is an array, env is `environment`, type is local/remote, variables use {env:VAR}.', zh: '`command` 为数组、环境变量键为 `environment`、type 为 local/remote、变量语法 {env:VAR}。' },
    paths: () => [
      { scope: 'global', path: xdgConfig('opencode', 'opencode.json') },
      { scope: 'project', path: join('opencode.json'), relative: true },
    ],
  },
  {
    id: 'trae',
    label: { en: 'Trae', zh: 'Trae' },
    order: 40,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.plain,
    caps: { ...STDIO_CAPS },
    note: { en: 'Global path carries an extra `User` level.', zh: '全局路径多一层 `User`。' },
    paths: () => [{ scope: 'global', path: appData('Trae', 'User', 'mcp.json') }],
  },
  {
    /*
     * The mainland build of Trae is a separate installation with its own config
     * directory, and it can be installed alongside the international build on the
     * same machine — so it is its own row, not a second path on `trae`. Its file
     * is the same shape (`mcpServers`, plain stdio entries) but carries extra
     * `fromGalleryId` / `disabled` keys from the built-in gallery; `disabled` is
     * the one modelled field and the rest round-trips untouched through `extra`.
     */
    id: 'trae-cn',
    label: { en: 'Trae CN', zh: 'Trae 国内版' },
    order: 41,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.plain,
    caps: { ...STDIO_CAPS },
    note: { en: 'Mainland build, separate install; entries carry gallery-only keys that are preserved as-is.', zh: '国内版为独立安装；条目带画廊专用键，会原样保留。' },
    paths: () => [{ scope: 'global', path: appData('Trae CN', 'User', 'mcp.json') }],
  },
  {
    id: 'codebuddy',
    label: { en: 'CodeBuddy', zh: 'CodeBuddy' },
    order: 50,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.plain,
    caps: { ...STDIO_CAPS },
    paths: () => [{ scope: 'global', path: join(HOME, '.codebuddy', 'mcp.json') }],
  },
  {
    id: 'roo',
    label: { en: 'Roo Code', zh: 'Roo Code' },
    order: 61,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.roo,
    caps: { ...STDIO_CAPS, enabled: true, autoApprove: true, timeoutMs: true, projectScope: true },
    note: { en: 'Auto-approve is `alwaysAllow`; timeout is in seconds.', zh: '自动批准字段为 `alwaysAllow`；超时为秒。' },
    paths: () => [
      { scope: 'global', path: join(vscodeUserDir(), 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json') },
      { scope: 'project', path: join('.roo', 'mcp.json'), relative: true },
    ],
  },
  {
    id: 'claude-desktop',
    label: { en: 'Claude Desktop', zh: 'Claude Desktop' },
    order: 70,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.plain,
    caps: { ...STDIO_CAPS },
    note: { en: 'Official build is stdio only; remote needs an mcp-remote bridge.', zh: '官方仅支持 stdio；远程需 mcp-remote 桥接。' },
    paths: () => [{ scope: 'global', path: appData('Claude', 'claude_desktop_config.json') }],
  },
  {
    id: 'claude-code',
    label: { en: 'Claude Code', zh: 'Claude Code' },
    order: 71,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.claudeCode,
    caps: { ...STDIO_CAPS, timeoutMs: true, projectScope: true },
    note: { en: 'Remote entries must declare `type`; project scope also needs approval keys in ~/.claude/settings.json.', zh: '远程条目必须显式声明 `type`；项目级还需在 ~/.claude/settings.json 写入批准字段。' },
    paths: () => [
      { scope: 'global', path: join(HOME, '.claude.json') },
      { scope: 'project', path: join('.mcp.json'), relative: true },
    ],
  },
  {
    id: 'cursor',
    label: { en: 'Cursor', zh: 'Cursor' },
    order: 72,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.cursor,
    caps: { ...STDIO_CAPS, envFile: true, projectScope: true },
    note: { en: 'Remote entries are recognised by `url` alone; no type tag required.', zh: '远程条目仅靠 `url` 判别，无需 type。' },
    paths: () => [
      { scope: 'global', path: join(HOME, '.cursor', 'mcp.json') },
      { scope: 'project', path: join('.cursor', 'mcp.json'), relative: true },
    ],
  },
  {
    id: 'windsurf',
    label: { en: 'Windsurf', zh: 'Windsurf' },
    order: 73,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: { ...TYPE.plain, urlKey: 'serverUrl' },
    caps: { ...STDIO_CAPS },
    note: { en: 'Remote URL key is `serverUrl`; writing `url` silently does nothing.', zh: '远程 URL 键为 `serverUrl`；写成 `url` 会静默失效。' },
    paths: () => [{ scope: 'global', path: join(HOME, '.codeium', 'windsurf', 'mcp_config.json') }],
  },
  {
    id: 'vscode',
    label: { en: 'VS Code', zh: 'VS Code' },
    order: 74,
    format: 'json',
    containerKey: 'servers',
    dialect: TYPE.vscode,
    caps: { ...STDIO_CAPS, envFile: true, projectScope: true },
    note: { en: 'Container key is `servers`; top-level `inputs`/`sandbox` must survive rewrites.', zh: '容器键为 `servers`；顶层 `inputs`/`sandbox` 必须保留。' },
    paths: () => [
      { scope: 'global', path: join(vscodeUserDir(), 'mcp.json') },
      { scope: 'project', path: join('.vscode', 'mcp.json'), relative: true },
    ],
  },
  {
    id: 'gemini',
    label: { en: 'Gemini CLI', zh: 'Gemini CLI' },
    order: 75,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.gemini,
    caps: { ...STDIO_CAPS, timeoutMs: true },
    note: { en: '`httpUrl` is streamable HTTP, `url` is SSE; timeout is milliseconds.', zh: '`httpUrl` 表示 streamable HTTP，`url` 表示 SSE；超时单位为毫秒。' },
    paths: () => [{ scope: 'global', path: join(HOME, '.gemini', 'settings.json') }],
  },
  {
    id: 'qwen',
    label: { en: 'Qwen Code', zh: 'Qwen Code' },
    order: 76,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.gemini,
    caps: { ...STDIO_CAPS, timeoutMs: true },
    paths: () => [{ scope: 'global', path: join(HOME, '.qwen', 'settings.json') }],
  },
  {
    id: 'copilot-cli',
    label: { en: 'GitHub Copilot CLI', zh: 'GitHub Copilot CLI' },
    order: 77,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.plain,
    caps: { ...STDIO_CAPS },
    paths: () => [{ scope: 'global', path: join(process.env.COPILOT_HOME ?? join(HOME, '.copilot'), 'mcp-config.json') }],
  },
  {
    id: 'kiro',
    label: { en: 'Kiro', zh: 'Kiro' },
    order: 78,
    format: 'json',
    containerKey: 'mcpServers',
    dialect: TYPE.plain,
    caps: { ...STDIO_CAPS, enabled: true, autoApprove: true, projectScope: true },
    note: { en: 'Saving reconnects immediately; no restart needed.', zh: '保存即自动重连，无需重启。' },
    paths: () => [
      { scope: 'global', path: join(HOME, '.kiro', 'settings', 'mcp.json') },
      { scope: 'project', path: join('.kiro', 'settings', 'mcp.json'), relative: true },
    ],
  },
  {
    id: 'zed',
    label: { en: 'Zed', zh: 'Zed' },
    order: 79,
    format: 'json',
    containerKey: 'context_servers',
    dialect: TYPE.zed,
    caps: { ...STDIO_CAPS },
    note: { en: 'Container key is `context_servers`; local vs remote is inferred from command/url.', zh: '容器键为 `context_servers`；本地/远程靠 command/url 判别。' },
    paths: () => [{ scope: 'global', path: zedConfig('settings.json') }],
  },
  {
    id: 'continue',
    label: { en: 'Continue', zh: 'Continue' },
    order: 80,
    format: 'yaml',
    containerKey: 'mcpServers',
    dialect: TYPE.continueLike,
    caps: { ...STDIO_CAPS },
    readOnly: true,
    note: { en: 'YAML with an array of named servers; read-only here to protect hand-written structure.', zh: 'YAML 且为带 name 的数组形式；此处只读以保护手写结构。' },
    paths: () => [{ scope: 'global', path: join(HOME, '.continue', 'config.yaml') }],
  },
  {
    id: 'dsh',
    label: { en: 'DeepSeek Harness', zh: 'DeepSeek Harness' },
    order: 5,
    format: 'entry',
    containerKey: 'config',
    dialect: TYPE.plain,
    caps: { ...STDIO_CAPS, enabled: true, oauth: false },
    managed: true,
    note: { en: 'Written through configEditor against @deepseek-ai/dsh-mcp-client; applies hot, no restart.', zh: '通过 configEditor 写入 @deepseek-ai/dsh-mcp-client；热替换即时生效，无需重启。' },
    paths: () => [],
  },
];

export const CLIENT_BY_ID = new Map(CLIENTS.map((client) => [client.id, client]));

/** Resolve `relative` paths against a workspace root. */
export function resolveClientPaths(client, workspaceRoot) {
  const out = [];
  for (const location of client.paths()) {
    if (location.relative) {
      if (!workspaceRoot) continue;
      out.push({ scope: location.scope, path: join(workspaceRoot, location.path), relative: location.path });
      continue;
    }
    out.push({ scope: location.scope, path: location.path });
  }
  return out;
}

/** All distinct global paths, used by the scanner. */
export function globalPaths() {
  const out = [];
  for (const client of CLIENTS) {
    if (client.managed) continue;
    for (const location of resolveClientPaths(client, undefined)) {
      if (location.scope === 'global') out.push({ clientId: client.id, path: location.path });
    }
  }
  return out;
}
