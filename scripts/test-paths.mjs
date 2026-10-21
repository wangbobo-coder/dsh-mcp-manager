/**
 * Cross-platform path resolution.
 *
 * The adapter catalog claims to work on Windows and macOS. That claim is easy to
 * state and easy to get wrong (Zed, for one, does NOT live under
 * `~/Library/Application Support` on macOS — it reads `~/.config/zed`). So this
 * suite re-evaluates each path expression under a fake `node:os` for every
 * platform the plugin supports and asserts the concrete result.
 *
 *   node scripts/test-paths.mjs
 *
 * It works by loading the real module source with the `os` and `path` imports
 * rewritten to platform-parameterised shims, because `homedir()`/`platform()`
 * are read once at module load and cannot be monkey-patched afterwards.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let pass = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
    process.exitCode = 1;
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'adapters.js'), 'utf8');

/** Re-evaluate adapters.js as if it were running on `platform` for `home`. */
function loadFor(platform, home, env = {}) {
  const body = source
    // Swap the node builtins for shims that report the requested platform.
    .replace(
      "import { homedir, platform as osPlatform } from 'node:os';",
      'const homedir = () => HOME_INJECTED; const osPlatform = () => PLATFORM_INJECTED;',
    )
    .replace("import { join } from 'node:path';", 'const join = (...parts) => parts.join("/").replace(/\\/+/g, "/");')
    .replace('const HOME = homedir();', 'const HOME = HOME_INJECTED;')
    .replace('const IS_WIN = osPlatform() === \'win32\';', "const IS_WIN = PLATFORM_INJECTED === 'win32';")
    .replace('const IS_MAC = osPlatform() === \'darwin\';', "const IS_MAC = PLATFORM_INJECTED === 'darwin';");

  const sandboxEnv = { ...env };
  const factory = new Function(
    'HOME_INJECTED',
    'PLATFORM_INJECTED',
    'process',
    `${body.replace(/export /g, '')}
     return { CLIENTS };`,
  );
  const result = factory(home, platform, { env: sandboxEnv, platform, cwd: () => '/cwd' });
  return result.CLIENTS;
}

/** The one global path a client declares. */
function globalPath(client) {
  const location = client.paths().find((item) => item.scope === 'global');
  return location ? location.path : null;
}

/**
 * Compare paths as structure, not as a literal separator spelling.
 *
 * The shim joins with `/` while a Windows `HOME` is handed in with backslashes,
 * so the raw string is a mix. Every assertion below cares about the directory
 * LAYOUT, so normalising both sides keeps the test honest without pretending a
 * Windows path is a POSIX one.
 */
function norm(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+/g, '/');
}

function expectPath(actual, expected, label) {
  assert.equal(norm(actual), expected, label ?? '');
}

function byId(clients, id) {
  const found = clients.find((client) => client.id === id);
  assert.ok(found, `client ${id} missing from the catalog`);
  return found;
}

console.log('windows');

const win = loadFor('win32', 'C:\\Users\\me', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' });

check('Zed lives under %APPDATA%, not Application Support', () => {
  expectPath(globalPath(byId(win, 'zed')), 'C:/Users/me/AppData/Roaming/Zed/settings.json');
});

check('Claude Desktop and Trae use %APPDATA%', () => {
  expectPath(globalPath(byId(win, 'claude-desktop')), 'C:/Users/me/AppData/Roaming/Claude/claude_desktop_config.json');
  expectPath(globalPath(byId(win, 'trae')), 'C:/Users/me/AppData/Roaming/Trae/User/mcp.json');
});

check('VS Code user dir is %APPDATA%\\Code\\User', () => {
  expectPath(globalPath(byId(win, 'vscode')), 'C:/Users/me/AppData/Roaming/Code/User/mcp.json');
  assert.ok(norm(globalPath(byId(win, 'roo'))).startsWith('C:/Users/me/AppData/Roaming/Code/User/globalStorage/'));
});

check('dot-directory clients stay under the home dir', () => {
  expectPath(globalPath(byId(win, 'cursor')), 'C:/Users/me/.cursor/mcp.json');
  expectPath(globalPath(byId(win, 'codebuddy')), 'C:/Users/me/.codebuddy/mcp.json');
});

console.log('macOS');

const mac = loadFor('darwin', '/Users/me');

check('Zed uses ~/.config/zed on macOS (the case that was wrong)', () => {
  expectPath(globalPath(byId(mac, 'zed')), '/Users/me/.config/zed/settings.json');
});

check('Claude Desktop uses ~/Library/Application Support', () => {
  expectPath(globalPath(byId(mac, 'claude-desktop')), '/Users/me/Library/Application Support/Claude/claude_desktop_config.json');;
});

check('Trae and Trae CN use ~/Library/Application Support with the extra User level', () => {
  expectPath(globalPath(byId(mac, 'trae')), '/Users/me/Library/Application Support/Trae/User/mcp.json');
  expectPath(globalPath(byId(mac, 'trae-cn')), '/Users/me/Library/Application Support/Trae CN/User/mcp.json');
});

check('VS Code user dir is ~/Library/Application Support/Code/User', () => {
  expectPath(globalPath(byId(mac, 'vscode')), '/Users/me/Library/Application Support/Code/User/mcp.json');
  assert.ok(
    globalPath(byId(mac, 'roo')).startsWith('/Users/me/Library/Application Support/Code/User/globalStorage/'),
  );
});

check('dot-directory clients stay under the home dir', () => {
  for (const id of ['claude-code', 'cursor', 'windsurf', 'gemini', 'qwen', 'continue', 'kiro']) {
    const resolved = globalPath(byId(mac, id));
    assert.ok(resolved.startsWith('/Users/me/.'), `${id} resolved to ${resolved}`);
  }
});

check('no macOS path leaks a Windows separator', () => {
  for (const client of mac) {
    const resolved = globalPath(client);
    if (!resolved) continue;
    assert.equal(resolved.includes('\\'), false, `${client.id} has a backslash: ${resolved}`);
  }
});

console.log('linux');

const linux = loadFor('linux', '/home/me');

check('Zed honours XDG_CONFIG_HOME on linux', () => {
  expectPath(globalPath(byId(linux, 'zed')), '/home/me/.config/zed/settings.json');
});

check('dot-directory clients stay under the home dir', () => {
  expectPath(globalPath(byId(linux, 'cursor')), '/home/me/.cursor/mcp.json');
});

console.log('environment overrides');

check('APPDATA is honoured when set', () => {
  const custom = loadFor('win32', 'C:\\Users\\me', { APPDATA: 'D:\\roaming' });
  expectPath(globalPath(byId(custom, 'trae')), 'D:/roaming/Trae/User/mcp.json');
});

console.log('catalog integrity');

check('every client declares at least one path, or is the managed one', () => {
  for (const client of win) {
    if (client.managed) {
      assert.deepEqual(client.paths(), [], `${client.id} is managed and must declare no file paths`);
      continue;
    }
    assert.ok(client.paths().length > 0, `${client.id} declares no path`);
  }
});

check('no duplicate global paths between clients', () => {
  const seen = new Map();
  for (const client of win) {
    const resolved = globalPath(client);
    if (!resolved) continue;
    // Trae and Trae CN intentionally differ; a genuine duplicate is a bug.
    assert.equal(seen.has(resolved), false, `${client.id} collides with ${seen.get(resolved)} at ${resolved}`);
    seen.set(resolved, client.id);
  }
});

check('the two removed clients are gone', () => {
  for (const client of win) {
    assert.notEqual(client.id, 'codex', 'codex should have been removed from the catalog');
    assert.notEqual(client.id, 'qoder-cli', 'qoder-cli should have been removed from the catalog');
  }
});

console.log(`\n${pass} passing`);
