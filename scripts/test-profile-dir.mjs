/**
 * Profile-directory resolution test.
 *
 * The plugin writes its DSH rows into the ACTIVE profile's patch layer. Getting
 * that path wrong does not raise an error — it creates a directory nobody reads
 * and the rows sit "activating" forever. That happened on the VM, whose panel is
 * started as `dsh --profile superagent` and therefore has no `DSH_PROFILE_DIR`:
 * the old fallback wrote into `~/.dsh/profiles/desktop`.
 *
 * These cases pin the resolution order and, just as important, that an
 * unidentifiable profile yields `undefined` (a refusal) rather than a guess.
 *
 *   node scripts/test-profile-dir.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProfileDir } from '../lib/index.js';

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

const home = mkdtempSync(join(tmpdir(), 'mcpm-profile-'));
/** Make `profiles/<name>/cordis.yml` exist, the way a real profile looks. */
function makeProfile(name) {
  const dir = join(home, 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'cordis.yml'), '[]\n', 'utf8');
  return dir;
}

check('DSH_PROFILE_DIR wins over everything', () => {
  const explicit = join(home, 'elsewhere');
  const got = resolveProfileDir({
    home,
    env: { DSH_PROFILE_DIR: explicit, DSH_PROFILE: 'web' },
    argv: ['node', 'dsh', '--profile', 'superagent'],
  });
  assert.equal(got, explicit);
});

check('the running Host profileContext wins over env and flags', () => {
  const fromContext = join(home, 'profiles', 'desktop');
  const got = resolveProfileDir({
    home,
    profile: { name: 'desktop', dir: fromContext },
    env: { DSH_PROFILE_DIR: join(home, 'elsewhere'), DSH_PROFILE: 'web' },
    argv: ['node', 'dsh', '--profile', 'superagent'],
  });
  assert.equal(got, fromContext, 'the Desktop app exports no DSH_PROFILE_DIR into its own process');
});

check('profileContext.name is enough when the Host reports no dir', () => {
  makeProfile('superagent');
  const got = resolveProfileDir({ home, profile: { name: 'superagent' }, env: {}, argv: ['node', 'dsh'] });
  assert.equal(got, join(home, 'profiles', 'superagent'));
});

check('reads the --profile flag the process was started with', () => {
  makeProfile('superagent');
  const got = resolveProfileDir({ home, env: {}, argv: ['node', '/opt/dsh/node_modules/.bin/dsh', '--profile', 'superagent', '--no-open'] });
  assert.equal(got, join(home, 'profiles', 'superagent'));
});

check('reads --profile=<name> too', () => {
  makeProfile('web');
  const got = resolveProfileDir({ home, env: {}, argv: ['node', 'dsh', '--profile=web'] });
  assert.equal(got, join(home, 'profiles', 'web'));
});

check('falls back to DSH_PROFILE when no flag is present', () => {
  makeProfile('headless');
  const got = resolveProfileDir({ home, env: { DSH_PROFILE: 'headless' }, argv: ['node', 'dsh', 'web'] });
  assert.equal(got, join(home, 'profiles', 'headless'));
});

check('a lone profile on the machine is unambiguous', () => {
  const solo = mkdtempSync(join(tmpdir(), 'mcpm-solo-'));
  mkdirSync(join(solo, 'profiles', 'only'), { recursive: true });
  writeFileSync(join(solo, 'profiles', 'only', 'cordis.yml'), '[]\n', 'utf8');
  const got = resolveProfileDir({ home: solo, env: {}, argv: ['node', 'dsh', 'web'] });
  assert.equal(got, join(solo, 'profiles', 'only'));
});

check('refuses to guess between several profiles', () => {
  const many = mkdtempSync(join(tmpdir(), 'mcpm-many-'));
  for (const name of ['web', 'headless']) {
    mkdirSync(join(many, 'profiles', name), { recursive: true });
    writeFileSync(join(many, 'profiles', name, 'cordis.yml'), '[]\n', 'utf8');
  }
  const got = resolveProfileDir({ home: many, env: {}, argv: ['node', 'dsh', 'web'] });
  assert.equal(got, undefined, 'the old desktop fallback created a profile nobody reads');
});

check('refuses when there is no profile at all', () => {
  const empty = mkdtempSync(join(tmpdir(), 'mcpm-empty-'));
  const got = resolveProfileDir({ home: empty, env: {}, argv: ['node', 'dsh'] });
  assert.equal(got, undefined);
});

console.log(`\n${pass} checks passed${process.exitCode ? ' (with failures)' : ''}`);
