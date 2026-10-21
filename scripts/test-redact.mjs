/**
 * Redaction and literal-credential policy.
 *
 * These assertions guard the rule that no credential literal ever reaches the
 * browser (and therefore the model's context), and that a literal in any
 * position — env, header, or a command-line flag — blocks a project-scope
 * write. Both were violated in earlier revisions, so they are pinned here.
 */
import { isSecretKey, maskValue, redactServer, secretArgs } from '../lib/canonical.js';
import { hasLiteralSecret } from '../lib/ops.js';

let failed = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const TOKEN = 'figd_EXAMPLEnotarealtoken000000000000000';

console.log('redaction\n');

await check('an inline --flag=value credential is masked but keeps its flag', () => {
  const out = redactServer({
    name: 'figma', transport: 'stdio', command: 'npx',
    args: ['-y', 'figma-developer-mcp', `--figma-api-key=${TOKEN}`, '--stdio'],
    env: {}, headers: {},
  }, false);
  assert(!JSON.stringify(out).includes(TOKEN), 'token leaked');
  assert(out.args[2] === `--figma-api-key=${maskValue(TOKEN)}`, `unexpected arg ${out.args[2]}`);
});

await check('a --flag value credential in the next argument is masked', () => {
  const out = redactServer({ name: 'x', args: ['--api-key', 'abcdef123456789'], env: {}, headers: {} }, false);
  assert(out.args[0] === '--api-key', 'flag was destroyed');
  assert(out.args[1] === maskValue('abcdef123456789'), `unexpected value ${out.args[1]}`);
});

await check('a credential reference is left readable', () => {
  const out = redactServer({ name: 'x', args: ['--api-key', '${MY_KEY}'], env: { TOKEN: '${TOKEN}' }, headers: {} }, false);
  assert(out.args[1] === '${MY_KEY}', 'reference was masked');
  assert(out.env.TOKEN === '${TOKEN}', 'env reference was masked');
});

await check('a trailing credential flag with no value is untouched', () => {
  const out = redactServer({ name: 'x', args: ['--api-key'], env: {}, headers: {} }, false);
  assert(JSON.stringify(out.args) === '["--api-key"]', 'flag was rewritten');
});

await check('a credential nested inside raw is masked', () => {
  const out = redactServer({
    name: 'x', env: {}, headers: {},
    raw: { mcpServers: { x: { env: { API_TOKEN: TOKEN }, deep: [{ password: 'hunter2hunter2' }] } } },
  }, false);
  const text = JSON.stringify(out);
  assert(!text.includes(TOKEN), 'nested token leaked');
  assert(!text.includes('hunter2hunter2'), 'nested password leaked');
});

await check('a credential in an args array inside raw is masked', () => {
  const out = redactServer({
    name: 'Framelink Figma MCP', env: {}, headers: {},
    args: ['-y', 'figma-developer-mcp', `--figma-api-key=${TOKEN}`, '--stdio'],
    raw: { command: 'npx', args: ['-y', 'figma-developer-mcp', `--figma-api-key=${TOKEN}`, '--stdio'] },
  }, false);
  const text = JSON.stringify(out);
  assert(!text.includes(TOKEN), 'raw args leaked the token');
  assert(out.raw.args[2] === `--figma-api-key=${maskValue(TOKEN)}`, 'raw args kept the literal');
});

await check('secret key NAMES stay visible so the UI can warn', () => {
  const out = redactServer({ name: 'x', env: { GITEE_ACCESS_TOKEN: 'abc' }, headers: {}, args: [] }, false);
  assert('GITEE_ACCESS_TOKEN' in out.env, 'key name was removed');
});

await check('reveal bypasses masking', () => {
  const out = redactServer({ name: 'x', args: [`--api-key=${TOKEN}`], env: {}, headers: {} }, true);
  assert(JSON.stringify(out).includes(TOKEN), 'reveal did not reveal');
});

await check('a secret key is recognised by name', () => {
  assert(isSecretKey('FIGMA_API_KEY'), 'FIGMA_API_KEY not recognised');
  assert(isSecretKey('Authorization'), 'Authorization not recognised');
  assert(!isSecretKey('LOG_LEVEL'), 'LOG_LEVEL wrongly secret');
});

console.log('\nliteral credential policy\n');

const argsServer = { name: 'figma', transport: 'stdio', command: 'npx', args: ['-y', 'figma-developer-mcp', `--figma-api-key=${TOKEN}`], env: {}, headers: {} };

await check('a literal credential in args blocks a project-scope write', () => {
  const hit = hasLiteralSecret(argsServer);
  assert(hit, 'no secret detected in args');
  assert(hit.where === 'args', `reported position ${hit.where}`);
});

await check('a literal credential in env blocks a project-scope write', () => {
  const hit = hasLiteralSecret({ name: 'x', args: [], env: { API_KEY: TOKEN }, headers: {} });
  assert(hit && hit.where === 'env', 'no secret detected in env');
});

await check('a literal credential in headers blocks a project-scope write', () => {
  const hit = hasLiteralSecret({ name: 'x', args: [], env: {}, headers: { Authorization: `Bearer ${TOKEN}` } });
  assert(hit && hit.where === 'header', 'no secret detected in headers');
});

await check('an argument reference is not a literal', () => {
  assert(hasLiteralSecret({ name: 'x', args: ['--api-key=${KEY}'], env: {}, headers: {} }) === null, 'reference treated as literal');
});

await check('secretArgs ignores ordinary arguments', () => {
  assert(secretArgs(['-y', '@playwright/mcp@latest', '--headless']).length === 0, 'false positive');
});

console.log(`\n${passed} passing, ${failed} failing`);
process.exit(failed === 0 ? 0 : 1);
