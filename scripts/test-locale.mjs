/**
 * Locale consistency test.
 *
 * The `meta` block in locale/*.json is what the Plugin Manager lists, and the
 * DICT inside lib/client.js is what the page renders. They are two separate
 * files that must agree on the key set, or the UI silently shows raw keys.
 *
 *   node scripts/test-locale.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'));
const zh = JSON.parse(readFileSync(join(root, 'locale', 'zh.json'), 'utf8'));

for (const [name, file] of [['en', en], ['zh', zh]]) {
  assert.equal(typeof file.meta?.title, 'string', `${name}: meta.title is required`);
  assert.equal(typeof file.meta?.description, 'string', `${name}: meta.description is required`);
  assert.ok(file.meta.title.length > 0 && file.meta.title.length <= 60, `${name}: meta.title should be short`);
}

// The client keeps both dictionaries inline; extract them and compare key sets.
const source = readFileSync(join(root, 'lib', 'client.js'), 'utf8');
const dictMatch = /const DICT = \{([\s\S]*?)\n    \};/.exec(source);
assert.ok(dictMatch, 'could not locate the DICT literal in lib/client.js');

const keysOf = (block, language) => {
  const start = block.indexOf(`${language}: {`);
  assert.ok(start >= 0, `could not locate the ${language} dictionary`);
  const body = block.slice(start);
  const found = new Set();
  for (const match of body.matchAll(/^\s{8}(?:'([^']+)'|([A-Za-z_][\w.]*))\s*:/gm)) {
    found.add(match[1] ?? match[2]);
  }
  return found;
};

const enKeys = keysOf(dictMatch[1], 'en');
const zhKeys = keysOf(dictMatch[1], 'zh');

assert.ok(enKeys.size > 30, `expected a populated English dictionary, saw ${enKeys.size} keys`);
assert.deepEqual(
  [...enKeys].sort(),
  [...zhKeys].sort(),
  'en and zh must define exactly the same keys — a missing Chinese string falls back to English mid-sentence',
);

// Every t('...') call in the client must resolve to a key that exists.
const used = new Set();
for (const match of source.matchAll(/\bt\('([^']+)'/g)) used.add(match[1]);
const missing = [...used].filter((key) => !enKeys.has(key));
assert.deepEqual(missing, [], `t() calls with no dictionary entry: ${missing.join(', ')}`);

const unused = [...enKeys].filter((key) => !used.has(key) && !['title', 'desc', 'meta.title', 'meta.description'].includes(key));

console.log(`locale: ${enKeys.size} keys, ${used.size} used by the client`);
if (unused.length) console.log(`  note: defined but unused — ${unused.join(', ')}`);
console.log('ok — en/zh key sets match and every t() call resolves');
