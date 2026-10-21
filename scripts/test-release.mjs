/*
 * Guards the release mechanics that nothing else watches: the version the probe
 * advertises, the version named in the docs, and the manifest fields the plugin
 * registry checks before it will list a bundle.
 *
 * These are the failures that pass every functional test and only surface after
 * publishing, when they can no longer be fixed in place.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, name), 'utf8');
const pkg = JSON.parse(read('package.json'));

let pass = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}
function equal(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}
function ok(value, what) {
  if (!value) throw new Error(what);
}

const VERSION = pkg.version;

check('the probe advertises the released version', () => {
  const source = read('lib/probe.js');
  const match = source.match(/CLIENT_INFO\s*=\s*\{[^}]*version:\s*'([^']+)'/);
  ok(match, 'no CLIENT_INFO version literal found in lib/probe.js');
  equal(match[1], VERSION, 'CLIENT_INFO version');
});

check('both READMEs name the current version', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const text = read(file);
    ok(text.includes(`@oh-agent/dsh-mcp-manager@${VERSION}`), `${file} does not install @${VERSION}`);
    ok(text.includes(`v${VERSION} release`), `${file} links a release other than v${VERSION}`);
  }
});

check('no README still points at an older release', () => {
  for (const file of ['README.md', 'README.en.md']) {
    const stale = [...read(file).matchAll(/mcp-manager@(\d+\.\d+\.\d+)/g)]
      .map((m) => m[1])
      .filter((v) => v !== VERSION);
    equal(stale.length, 0, `${file} install targets an older version (${stale.join(', ')})`);
  }
});

check('the README default language is Chinese, with a switch to English', () => {
  // The npm page shows README.md and nothing else, and most users here read
  // Chinese. A bilingual file that opens with an English-only preamble was
  // exactly the complaint this layout answers, so the Chinese side must be
  // complete on its own and the switch must be reachable from the first lines.
  const zh = read('README.md');
  ok(zh.includes('[English](README.en.md)'), 'README.md does not link to the English page');
  const head = zh.split('\n').slice(0, 6).join('\n');
  ok(head.includes('README.en.md'), 'the language switch is not in the first lines of README.md');

  const en = read('README.en.md');
  ok(en.includes('[中文](README.md)'), 'README.en.md does not link back to the Chinese page');
  // Chinese is allowed only where it is the subject: the switch label, and the
  // real server names the mount-name section has to quote to make its point.
  const prose = en
    .split('\n')
    .filter((line) => !line.includes('中文') && !line.includes('表单管理系统'))
    .join('\n');
  ok(!/[\u4e00-\u9fff]/.test(prose), 'README.en.md still carries Chinese prose');

  // Same section skeleton, so the two pages document the same product rather
  // than drifting apart one edit at a time.
  const sections = (text) => [...text.matchAll(/^## .+/gm)].map((m) => m[0].trim());
  equal(sections(en).length, sections(zh).length, 'README section count');
});

check('package name is the one the registry entry claims', () => {
  equal(pkg.name, '@oh-agent/dsh-mcp-manager', 'package name');
  const entry = read('market/wangbobo-coder__dsh-mcp-manager.yml');
  ok(entry.includes('name: wangbobo-coder/dsh-mcp-manager'), 'catalog entry name');
  ok(entry.includes(pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')), 'catalog entry url matches repository');
});

check('dsh.bundle is declared, with a patch file that exists', () => {
  // The single most common cause of a rejected catalog submission.
  ok(pkg.dsh && pkg.dsh.bundle, 'package.json declares no dsh.bundle');
  ok(pkg.dsh.bundle.patch, 'dsh.bundle.patch is missing');
  ok(existsSync(join(root, pkg.dsh.bundle.patch)), `patch file ${pkg.dsh.bundle.patch} does not exist`);
  ok(pkg.dsh.client && pkg.dsh.client.platform === 'web', 'dsh.client.platform must be web');
});

check('every published file path resolves', () => {
  for (const pattern of pkg.files) {
    const direct = pattern.replace(/\*.*$/, '');
    ok(existsSync(join(root, direct || pattern)) || existsSync(join(root, pattern)), `files[] entry ${pattern} does not exist`);
  }
});

check('the exports map points at real files', () => {
  for (const [key, target] of Object.entries(pkg.exports)) {
    if (key.includes('*')) continue;
    ok(existsSync(join(root, target)), `exports["${key}"] -> ${target} is missing`);
  }
});

check('locale files carry the display metadata the plugin manager reads', () => {
  for (const lang of ['en', 'zh']) {
    const dict = JSON.parse(read(`locale/${lang}.json`));
    ok(dict.meta?.title, `locale/${lang}.json has no meta.title`);
    ok(dict.meta?.description, `locale/${lang}.json has no meta.description`);
  }
});

check('a licence file is present and names the right holder', () => {
  const licence = read('LICENSE');
  ok(/MIT License/.test(licence), 'LICENSE is not MIT');
  ok(licence.includes('wangbobo-coder'), 'LICENSE names another holder');
});

check('the repository and bugs URLs point at the catalogue repo', () => {
  equal(pkg.repository.url, 'git+https://github.com/wangbobo-coder/dsh-mcp-manager.git', 'repository.url');
  ok(pkg.homepage.startsWith('https://github.com/wangbobo-coder/dsh-mcp-manager'), 'homepage');
  ok(pkg.bugs.url.startsWith('https://github.com/wangbobo-coder/dsh-mcp-manager'), 'bugs.url');
});

if (failures.length) {
  console.log(`\n${failures.length} failing:`);
  for (const line of failures) console.log(`  ✗ ${line}`);
  console.log(`\n${pass} passing, ${failures.length} failing`);
  process.exit(1);
}
console.log(`${pass} passing`);
