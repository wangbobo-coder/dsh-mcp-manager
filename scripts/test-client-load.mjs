/**
 * Load lib/client.js the way the Harness does, with no browser.
 *
 * This is a load-time smoke test, not a renderer test: it evaluates the module
 * inside a fake `window.__ModuleLoader__`, then runs `apply` against a fake ctx
 * to prove the locale dictionary and the settings.section registration are
 * well-formed. A typo that would blank the page at module-eval time (a missing
 * brace, a bad require, a slot registration with the wrong shape) or a
 * component that throws on its first render fails here instead of in the GUI.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

let passing = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passing += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${String(error.message).split('\n').join('\n       ')}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'assertion failed');
}
assert.equal = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message ? message + ': ' : ''}${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
};

/*
 * A React stand-in. `createElement` returns a plain descriptor so component
 * functions can be invoked and their trees inspected without a DOM; `useState`
 * replays a queue of prepared values so a component can be rendered directly in
 * its loaded state instead of its first-render loading state.
 */
let stateQueue = [];
const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
    };
  },
  useState(initial) {
    const next = stateQueue.length ? stateQueue.shift() : (typeof initial === 'function' ? initial() : initial);
    return [next, () => {}];
  },
  useEffect() {},
  useMemo(factory) { return factory(); },
  useCallback(fn) { return fn; },
  useRef(value) { return { current: value }; },
};

let loaded = null;
const fakeWindow = { __ModuleLoader__: { load(definition) { loaded = definition; } } };
const require = (id) => {
  if (id === 'react') return React;
  throw new Error(`unexpected require(${id}) — client plugins may only require react`);
};

const evaluate = new Function('window', 'module', 'exports', 'require', source);
evaluate(fakeWindow, {}, {}, require);

console.log('client module (fake loader, no DOM)');

check('the module registers itself under the package id', () => {
  assert(loaded, 'window.__ModuleLoader__.load was not called');
  assert.equal(loaded.id, '@oh-agent/dsh-mcp-manager');
  assert.equal(typeof loaded.factory, 'function');
});

check('it requires no Harness client package', () => {
  assert(!/require\(\s*['"]@deepseek-ai\//.test(source), 'client plugins must not require a Harness client package');
});

const plugin = loaded.factory(require);

check('the plugin injects slots and locale and exposes apply', () => {
  assert(Array.isArray(plugin.inject), 'inject must be an array');
  assert.equal(plugin.inject.join(','), 'slots,locale');
  assert.equal(typeof plugin.apply, 'function');
});

const registered = { locales: [], slots: [], effects: 0 };
const makeCtx = (active = 'en') => ({
  effect(fn) { registered.effects += 1; return fn(); },
  locale: {
    register(ns, dict) { registered.locales.push({ ns, dict }); },
    bind: () => (key) => key,
    getLocale: () => ({ active }),
  },
  slots: {
    inject(key, callback) { registered.injectedInto = key; return callback(); },
    register(options, component) { registered.slots.push({ options, component }); return () => {}; },
  },
});
const ctx = makeCtx();

check('apply registers the dictionary and the settings section', () => {
  plugin.apply(ctx);
  assert.equal(registered.locales.length, 1);
  assert.equal(registered.locales[0].ns, 'mcp-manager');
  assert.equal(registered.injectedInto, 'settings.section');
  assert.equal(registered.slots.length, 1);
  const { options, component } = registered.slots[0];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'mcp-manager');
  assert.equal(options.order, 26);
  assert.equal(typeof options.label, 'function');
  assert.equal(options.locale, 'mcp-manager');
  assert.equal(typeof component, 'function');
});

check('the dictionary is registered through ctx.effect so unload disposes it', () => {
  assert(registered.effects >= 1, 'the locale dictionary must be an effect');
});

check('the dictionary carries both locales with identical key sets', () => {
  const dict = registered.locales[0].dict;
  assert(dict.en && dict.zh, 'both en and zh must be present');
  const en = Object.keys(dict.en).sort();
  const zh = Object.keys(dict.zh).sort();
  assert.equal(en.join('|'), zh.join('|'), 'en and zh key sets must match');
  assert(en.length > 40, `expected a full dictionary, got ${en.length}`);
  for (const locale of ['en', 'zh']) {
    for (const [key, value] of Object.entries(dict[locale])) {
      assert(typeof value === 'string' && value.trim().length > 0, `${locale}.${key} is empty`);
    }
  }
});

/* ------------------------------------------------------------------ render -- */

const component = registered.slots[0].component;

const SNAPSHOT = {
  clients: [
    { id: 'dsh', label: { en: 'DeepSeek Harness', zh: 'DeepSeek Harness' }, order: 5, installed: true, managed: true, readOnly: false },
    { id: 'qoder-ide', label: { en: 'Qoder IDE', zh: 'Qoder' }, order: 30, installed: true, managed: false, readOnly: false },
    { id: 'continue', label: { en: 'Continue', zh: 'Continue' }, order: 80, installed: true, managed: false, readOnly: true },
  ],
  sources: [
    {
      id: 'dsh:profile:x', clientId: 'dsh', clientLabel: { en: 'DeepSeek Harness' }, scope: 'profile',
      path: '(profile composition)', exists: true, readOnly: false, serverCount: 1,
      servers: [{ name: 'context7', transport: 'stdio', enabled: true, entryId: 'include:mcp-context7', pending: false, secrets: [], server: { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } }],
    },
    {
      id: 'qoder-ide:global:y', clientId: 'qoder-ide', clientLabel: { en: 'Qoder IDE' }, scope: 'global',
      path: 'C:\\Users\\x\\AppData\\Roaming\\Qoder\\SharedClientCache\\mcp.json', exists: true, readOnly: false, serverCount: 2,
      servers: [
        { name: 'figma', transport: 'stdio', enabled: true, entryId: null, pending: false, secrets: ['FIGMA_API_KEY'], server: { name: 'figma', transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', '--figma-api-key=figd••••0000', '--stdio'] } },
        { name: 'context7', transport: 'stdio', enabled: true, entryId: null, pending: false, secrets: [], server: { name: 'context7', transport: 'stdio', command: 'npx', args: [] } },
      ],
    },
  ],
  servers: [
    {
      name: 'context7', transport: 'stdio', clientCount: 2, clients: ['dsh', 'qoder-ide'], drift: [], canonical: { name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'], env: {} },
      targets: [
        { clientId: 'dsh', enabled: true, pending: false, entryId: 'include:mcp-context7', scope: 'profile', path: '(profile composition)', server: { secrets: [] } },
        { clientId: 'qoder-ide', enabled: true, pending: false, entryId: null, scope: 'global', path: 'y', server: { secrets: [] } },
      ],
    },
    {
      name: 'figma', transport: 'stdio', clientCount: 1, clients: ['qoder-ide'], drift: [], canonical: { name: 'figma', transport: 'stdio', command: 'npx', args: ['--figma-api-key=figd••••0000'], env: {} },
      targets: [{ clientId: 'qoder-ide', enabled: true, pending: false, entryId: null, scope: 'global', path: 'y', server: { secrets: [{ key: 'FIGMA_API_KEY' }] } }],
    },
  ],
  literalSecrets: [{ server: 'figma', key: 'FIGMA_API_KEY', where: 'args' }],
  warnings: [],
  history: [],
};

/**
 * Render the page with a prepared state.
 *
 * The slot registration is a thin wrapper that returns h(McpManagerPage, props),
 * so invoking it yields a descriptor whose `type` is the page component. That
 * indirection is deliberate on the slot side (it keeps owner props explicit),
 * so the test unwraps it and calls the page itself.
 */
function render(state, active = 'en', overrides = {}) {
  /*
   * The page declares its hooks in a fixed order (see lib/client.js): state,
   * error, loading, reveal, query, toolFilter, statusFilter, openName,
   * expanded, probes, probing, busy, toast, snippet, syncOpen, syncPicks,
   * historyOpen. Replaying a value per hook lands the component in its LOADED
   * state instead of its first-render loading state.
   *
   * `expanded` defaults to every card OPEN so a test that inspects rows does not
   * have to know each source id. That default belongs to the TEST, not to the
   * component — the component starts fully collapsed (`{}`), and the
   * "cards start collapsed" check below passes `expanded: {}` explicitly to
   * assert the real first-render state.
   */
  const allOpen = state && state.sources
    ? Object.fromEntries(state.sources.map((source) => [source.id, true]))
    : {};
  stateQueue = state === null
    ? [null, null, true]
    : [
      state, null, false, false,
      overrides.query ?? '', overrides.toolFilter ?? 'all', overrides.statusFilter ?? 'all',
      overrides.openName ?? null, overrides.expanded ?? allOpen,
      {}, {}, false, null, null, false, [], overrides.historyOpen ?? false,
    ];
  /*
   * The slot registration closes over the ctx passed to apply, so a locale
   * switch needs its own apply() — passing __ctx in props cannot override it
   * (the registration spreads owner props first and then pins its own ctx).
   */
  const page = active === 'en' ? component : (() => {
    plugin.apply(makeCtx('zh'));
    return registered.slots[registered.slots.length - 1].component;
  })();
  try {
    const wrapper = page({ close: () => {} });
    /* The slot registration wraps the page to bind owner props; unwrap and run it. */
    const rendered = typeof wrapper.type === 'function' ? wrapper.type(wrapper.props) : wrapper;
    return expand(rendered);
  } finally {
    stateQueue = [];
  }
}

/**
 * Expand function components into their rendered output.
 *
 * createElement does not run components (a real renderer does), so a helper
 * like MountSwitch stays a descriptor until we call it. Nested hooks get a
 * fresh empty queue, which makes useState fall back to its initial value —
 * correct for the stateless helpers that appear inside rows.
 */
function expand(node, depth = 0) {
  if (depth > 12 || !node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1));
  if (typeof node.type === 'function') {
    const saved = stateQueue;
    stateQueue = [];
    try {
      return expand(node.type(node.props), depth + 1);
    } finally {
      stateQueue = saved;
    }
  }
  if (!node.children || node.children.length === 0) return node;
  return { ...node, children: node.children.map((child) => expand(child, depth + 1)) };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  visit(node);
  if (node.children) node.children.forEach((child) => walk(child, visit));
}

function findByClass(tree, className) {
  const hits = [];
  walk(tree, (node) => {
    if (node.props && typeof node.props.className === 'string') {
      if (node.props.className.split(/\s+/).includes(className)) hits.push(node);
    }
  });
  return hits;
}

check('the page renders its loading state without throwing', () => {
  const tree = render(null);
  assert(tree, 'the component returned nothing');
  assert.equal(tree.props.className, 'mcpm-root');
  assert(findByClass(tree, 'mcpm-empty').length >= 1, 'the loading state should show the empty block');
});

/*
 * The dialog is position:fixed. If the container-query context sat on the root,
 * layout containment would make the root the containing block for that dialog,
 * so the dialog would cover only this column and scroll away with it. Keep the
 * context on an inner wrapper and the dialog as a SIBLING of that wrapper.
 */
check('the container-query wrapper never contains the fixed-position dialog', () => {
  const tree = render(SNAPSHOT, 'en', { openName: 'figma' });
  const main = findByClass(tree, 'mcpm-main');
  assert.equal(main.length, 1, 'page content should live in a .mcpm-main wrapper');
  assert.equal(findByClass(main[0], 'mcpm-overlay').length, 0, 'the dialog must not be inside the container-query wrapper');
  assert.equal(findByClass(tree, 'mcpm-overlay').length, 1, 'the dialog still renders, just outside the wrapper');
  const css = findByClass(tree, 'mcpm-root')[0].children[0].children.join('');
  assert.equal(/\.mcpm-main\s*\{[^}]*container-type/.test(css), true, '.mcpm-main carries the container-query context');
  assert.equal(/\.mcpm-root\s*\{[^}]*container-type/.test(css), false, '.mcpm-root must NOT carry it');
});

check('a loaded snapshot renders one card per config file, with its path', () => {
  const tree = render(SNAPSHOT);
  const cards = findByClass(tree, 'mcpm-source');
  assert.equal(cards.length, 2, 'one card per file');
  const paths = findByClass(tree, 'mcpm-source-path').map((node) => node.children.join(''));
  assert(paths.some((path) => path.includes('mcp.json')), 'the Qoder file path must be visible');
  assert(paths.some((path) => path.includes('profile composition')), 'the DSH composition must be visible');
});

check('every server row carries a mount switch', () => {
  const tree = render(SNAPSHOT);
  const switches = findByClass(tree, 'mcpm-switch');
  /* 3 rows across 2 files (context7 twice, figma once). */
  assert.equal(switches.length, 3, `expected 3 switches, got ${switches.length}`);
  for (const node of switches) {
    assert.equal(node.props.role, 'switch');
    assert(node.props['aria-checked'] === 'true' || node.props['aria-checked'] === 'false', 'switch needs aria-checked');
    assert(typeof node.props.onClick === 'function', 'switch needs a handler');
    assert(typeof node.props['aria-label'] === 'string' && node.props['aria-label'].length > 0, 'switch needs a label');
  }
});

check('the same server keeps the same switch state in every file', () => {
  const tree = render(SNAPSHOT);
  const switches = findByClass(tree, 'mcpm-switch');
  /* context7 is mounted in DSH, so both of its rows read checked. */
  assert.equal(switches[0].props['aria-checked'], 'true');
  assert.equal(switches[1].props['aria-checked'], 'true');
  /* figma is not mounted anywhere in DSH. */
  assert.equal(switches[2].props['aria-checked'], 'false');
});

check('a server declared in two tools is labelled as shared', () => {
  const tree = render(SNAPSHOT);
  const tags = findByClass(tree, 'mcpm-tag').map((node) => node.children.join(''));
  assert(tags.some((text) => text.includes('2')), `expected a shared-in-2-tools tag, got ${JSON.stringify(tags)}`);
});

check('the summary strip totals servers, files and mounted count', () => {
  const tree = render(SNAPSHOT);
  const stats = findByClass(tree, 'mcpm-stat');
  assert.equal(stats.length, 4, 'four summary figures');
  const values = stats.map((stat) => String(stat.children[0].children.join('')));
  assert.equal(values[0], '2', 'servers');
  assert.equal(values[1], '2', 'files');
  assert.equal(values[2], '1', 'mounted');
  assert.equal(values[3], '1', 'literal credentials');
});

check('a literal credential produces a banner', () => {
  const tree = render(SNAPSHOT);
  const banners = findByClass(tree, 'mcpm-banner');
  assert(banners.length >= 1, 'the credential banner must render');
  assert(banners.some((node) => node.children.join('').includes('1')), 'the banner should carry the count');
});

check('the credential value is masked in the rendered tree', () => {
  const tree = render(SNAPSHOT);
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  assert(!texts.some((text) => text.includes('figd_EXAMPLE')), 'a raw credential must never reach the DOM');
});

check('an empty file renders its own explanatory row, not a blank card', () => {
  const empty = {
    ...SNAPSHOT,
    sources: [...SNAPSHOT.sources, { id: 'codebuddy:global:z', clientId: 'codebuddy', clientLabel: { en: 'CodeBuddy' }, scope: 'global', path: 'C:\\x\\mcp.json', exists: true, readOnly: false, serverCount: 0, servers: [] }],
  };
  const tree = render(empty);
  assert.equal(findByClass(tree, 'mcpm-source').length, 3);
  assert(findByClass(tree, 'mcpm-empty').length >= 1, 'an empty file should say so');
});

check('a Chinese locale renders without missing strings', () => {
  const tree = render(SNAPSHOT, 'zh');
  const texts = [];
  walk(tree, (node) => {
    for (const child of node.children ?? []) if (typeof child === 'string') texts.push(child);
  });
  assert(!texts.some((text) => /^[a-z]+(\.[a-z]+)+$/.test(text)), `raw locale keys leaked into the UI: ${JSON.stringify(texts.filter((text) => /^[a-z]+(\.[a-z]+)+$/.test(text)))}`);
  assert(texts.some((text) => /[\u4e00-\u9fa5]/.test(text)), 'the Chinese dictionary should produce Chinese text');
});

/* --------------------------------------------------------------- filtering -- */

check('the filter row offers a search box and two selects', () => {
  const tree = render(SNAPSHOT);
  assert(findByClass(tree, 'mcpm-filters').length === 1, 'a filter row must exist');
  assert.equal(findByClass(tree, 'mcpm-search').length, 1);
  assert.equal(findByClass(tree, 'mcpm-select').length, 2, 'a tool filter and a status filter');
});

check('search narrows rows without dropping the file that still matches', () => {
  const tree = render(SNAPSHOT, 'en', { query: 'figma' });
  const cards = findByClass(tree, 'mcpm-source');
  assert.equal(cards.length, 1, 'only the file holding a match survives');
  assert.equal(findByClass(tree, 'mcpm-row').length, 1, 'only the matching row renders');
  assert(findByClass(tree, 'mcpm-empty').length === 0, 'a match must not render the no-match block');
});

check('a search that matches nothing says so instead of showing an empty list', () => {
  const tree = render(SNAPSHOT, 'en', { query: 'no-such-server' });
  assert.equal(findByClass(tree, 'mcpm-source').length, 0);
  assert.equal(findByClass(tree, 'mcpm-empty').length, 1);
});

check('the status filter can show only servers mounted in DeepSeek Harness', () => {
  const tree = render(SNAPSHOT, 'en', { statusFilter: 'mounted' });
  const names = findByClass(tree, 'mcpm-name').map((node) => node.children.join(''));
  assert(names.every((name) => name === 'context7'), `only context7 is mounted, got ${JSON.stringify(names)}`);
});

check('cards start collapsed, so the page opens on the file list alone', () => {
  const tree = render(SNAPSHOT, 'en', { expanded: {} });
  assert.equal(findByClass(tree, 'mcpm-source').length > 0, true, 'the file cards still render');
  assert.equal(findByClass(tree, 'mcpm-row').length, 0, 'no rows are shown until a card is opened');
  const heads = findByClass(tree, 'mcpm-source-toggle');
  assert(heads.every((node) => node.props['aria-expanded'] === 'false'), 'every head reports collapsed');
});

check('filtering opens every card so a match cannot hide in a closed one', () => {
  const plain = render(SNAPSHOT, 'en', { expanded: {} });
  assert.equal(findByClass(plain, 'mcpm-row').length, 0, 'closed cards hide their rows');
  const filtered = render(SNAPSHOT, 'en', { expanded: {}, query: 'context7' });
  assert(findByClass(filtered, 'mcpm-row').length > 0, 'a filter must override the closed state');
});

/* ------------------------------------------------------------ detail modal -- */

check('opening a server renders a dialog, not an inline row expansion', () => {
  const tree = render(SNAPSHOT, 'en', { openName: 'figma' });
  const overlays = findByClass(tree, 'mcpm-overlay');
  assert.equal(overlays.length, 1, 'the detail view must be a dialog');
  const dialogs = findByClass(tree, 'mcpm-modal');
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].props.role, 'dialog');
  assert.equal(dialogs[0].props['aria-modal'], 'true');
});

check('the dialog lists every file that declares the server', () => {
  const tree = render(SNAPSHOT, 'en', { openName: 'context7' });
  const targets = findByClass(tree, 'mcpm-target');
  assert.equal(targets.length, 2, 'context7 is declared in dsh and qoder-ide');
  const names = targets.map((node) => {
    const label = findByClass(node, 'mcpm-target-name')[0];
    return label.children.join('');
  });
  assert(names.join('|').includes('DeepSeek Harness'), `expected the DSH target, got ${JSON.stringify(names)}`);
});

check('the card head shows a shortened path but keeps the full one in the title', () => {
  const tree = render(SNAPSHOT);
  const real = 'C:\\Users\\x\\AppData\\Roaming\\Qoder\\SharedClientCache\\mcp.json';
  const pathNode = findByClass(tree, 'mcpm-source-path').find((node) => node.props.title === real);
  assert(pathNode, 'the Qoder card must show its path');
  assert.equal(pathNode.children.join(''), '%APPDATA%\\Qoder\\SharedClientCache\\mcp.json');
  const placeholder = findByClass(tree, 'mcpm-source-path').find((node) => node.props.title === '(profile composition)');
  assert(placeholder, 'the DSH card keeps its composition placeholder instead of inventing a path');
  assert.equal(placeholder.children.join(''), '(profile composition)', 'a placeholder is not run through the path shortener');
});

check('a macOS path is shortened to ~ as well, so the head looks the same on every platform', () => {
  const macSnapshot = {
    ...SNAPSHOT,
    sources: [
      {
        ...SNAPSHOT.sources[1],
        path: '/Users/me/Library/Application Support/Trae/User/mcp.json',
      },
    ],
  };
  const tree = render(macSnapshot);
  const node = findByClass(tree, 'mcpm-source-path')[0];
  assert.equal(node.children.join(''), '~/Library/Application Support/Trae/User/mcp.json');
  assert.equal(node.props.title, '/Users/me/Library/Application Support/Trae/User/mcp.json', 'the full path stays discoverable');
});

check('row descriptors never carry a raw absolute path in the visible line', () => {  const tree = render(SNAPSHOT);
  for (const node of findByClass(tree, 'mcpm-meta')) {
    const text = node.children.join('');
    assert(!/[A-Za-z]:\\/.test(text), `a row line leaked a raw path: ${text}`);
  }
});

console.log(`\n${passing} passing${failures.length ? `, ${failures.length} failing` : ''}`);
if (failures.length) process.exitCode = 1;
