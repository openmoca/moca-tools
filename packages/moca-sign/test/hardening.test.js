// Names stay inside their folders, keys are never replaced, work factors stay in the Readers' range, failed writes
// leave nothing behind, and every failure exits non-zero with a clear message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateKeyPair, signPackage, reviewNodes, issueCopy, encryptPackage, ageEncrypt, checkWorkFactor, SignError, IssueError, EncryptError,
} from '../lib/index.js';

const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
const bin = fileURLToPath(new URL('../bin/moca-sign.js', import.meta.url));
const cli = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const tmp = () => mkdtempSync(join(tmpdir(), 'moca-sign-hard-'));
const key = generateKeyPair();

function minimal() {
  const dir = tmp();
  cpSync(join(spec, 'examples/minimal'), dir, { recursive: true });
  return dir;
}
const firstNode = (dir) => readdirSync(join(dir, 'content'), { recursive: true }).find((f) => f.endsWith('.md')).split('\\').join('/');

test('review --name stays inside attestations/reviews/', async () => {
  const dir = minimal();
  const node = firstNode(dir);
  for (const name of ['../../escape', '../x', 'a/b', '/abs', '.hidden', 'a..b', '', 'x'.repeat(101)]) {
    await assert.rejects(reviewNodes({ dir, nodes: [node], reviewer: 'human:a', outcome: 'accurate', name, privateKeyPem: key.privateKeyPem, keyid: 'rev' }), SignError, name);
  }
  assert.equal(existsSync(join(dir, 'escape.dsse.json')), false);
  const ok = await reviewNodes({ dir, nodes: [node], reviewer: 'human:a', outcome: 'accurate', name: 'week-47_a.1', privateKeyPem: key.privateKeyPem, keyid: 'rev' });
  assert.equal(ok.file, 'attestations/reviews/week-47_a.1.dsse.json');
});

test('two key ids that give the same file name cannot replace each other\'s signature', async () => {
  const dir = minimal();
  const other = generateKeyPair();
  await signPackage({ dir, privateKeyPem: key.privateKeyPem, keyid: 'Acme' });
  const before = readFileSync(join(dir, 'attestations/package.acme.dsse.json'), 'utf8');
  await assert.rejects(signPackage({ dir, privateKeyPem: other.privateKeyPem, keyid: 'acme' }), /already holds a signature by key Acme/);
  assert.equal(readFileSync(join(dir, 'attestations/package.acme.dsse.json'), 'utf8'), before);
  // The same key id signs again over its own file.
  await signPackage({ dir, privateKeyPem: key.privateKeyPem, keyid: 'Acme' });
  assert.deepEqual(readdirSync(join(dir, 'attestations')), ['package.acme.dsse.json']);
});

test('the scrypt work factor is a whole number from 15 to 20', async () => {
  for (const bad of [1, 10, 14, 21, 30, 15.5, Number.NaN]) {
    assert.throws(() => checkWorkFactor(bad), EncryptError);
    assert.throws(() => ageEncrypt(Buffer.from('x'), { passphrase: 'pw', workFactor: bad }), EncryptError);
  }
  checkWorkFactor(15);
  checkWorkFactor(20);
  const dir = tmp();
  for (const wf of ['10', '21', 'abc', '18x']) {
    const r = cli(['encrypt', join(spec, 'examples/minimal'), '-o', join(dir, `${wf}.mocae`), '--passphrase-env', 'MOCA_TEST_PW', '--work-factor', wf], { MOCA_TEST_PW: 'pw' });
    assert.equal(r.status, 2, wf);
    assert.match(r.stderr, /work factor must be a whole number from 15 to 20/);
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('encrypt leaves nothing behind when it fails, and replaces an output only once the new one passes', async () => {
  const dir = tmp();
  const out = join(dir, 'kb.mocae');
  writeFileSync(out, 'previous');
  await assert.rejects(encryptPackage({ pkg: join(spec, 'examples/minimal'), out, passphrase: 'pw', workFactor: 15, force: true, cover: true }), EncryptError);
  assert.equal(readFileSync(out, 'utf8'), 'previous');
  assert.deepEqual(readdirSync(dir), ['kb.mocae']);
  await encryptPackage({ pkg: join(spec, 'examples/minimal'), out, passphrase: 'pw', workFactor: 15, force: true });
  assert.notEqual(readFileSync(out, 'utf8'), 'previous');
  assert.deepEqual(readdirSync(dir), ['kb.mocae']);
});

async function issuable({ sign = true } = {}) {
  const dir = tmp();
  const issuer = generateKeyPair();
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({
    id: 'https://example.com/t/course', version: '1.0.0', title: 'T',
    issuedCopies: { issuers: [{ publicKey: issuer.publicKeyPem }], paths: ['content/'] },
  }));
  mkdirSync(join(dir, 'content'), { recursive: true });
  writeFileSync(join(dir, 'content', 'one.md'), '---\ntype: Lesson\ntitle: One\n---\n\n# One\n\nText.\n');
  if (sign) await signPackage({ dir, privateKeyPem: key.privateKeyPem, keyid: 'pub' });
  const copy = tmp();
  cpSync(dir, copy, { recursive: true });
  appendFileSync(join(copy, 'content', 'one.md'), '\nMarked.\n');
  return { dir, copy, issuer };
}

test('issue refuses an original with no publisher signature', async () => {
  const { dir, copy, issuer } = await issuable({ sign: false });
  await assert.rejects(issueCopy({ original: dir, copy, privateKeyPem: issuer.privateKeyPem, keyid: 'iss' }), /no publisher signature/);
  assert.equal(existsSync(join(copy, 'attestations')), false);
});

test('issue refuses a publisher signature for another digest, and one that does not verify against a given trust root', async () => {
  const { dir, copy, issuer } = await issuable();
  // A signature made before the original changed names another digest.
  appendFileSync(join(dir, 'content', 'one.md'), '\nEdited after signing.\n');
  const stale = tmp();
  cpSync(dir, stale, { recursive: true });
  await assert.rejects(issueCopy({ original: stale, copy, privateKeyPem: issuer.privateKeyPem, keyid: 'iss' }), IssueError);

  const fresh = await issuable();
  const stranger = { keys: [{ keyid: 'pub', publicKey: generateKeyPair().publicKeyPem, roles: ['package'] }] };
  await assert.rejects(issueCopy({ original: fresh.dir, copy: fresh.copy, privateKeyPem: fresh.issuer.privateKeyPem, keyid: 'iss', trustRoot: stranger }), /does not verify against the trust root/);
  const trusted = { keys: [{ keyid: 'pub', publicKey: key.publicKeyPem, roles: ['package'] }] };
  const out = await issueCopy({ original: fresh.dir, copy: fresh.copy, privateKeyPem: fresh.issuer.privateKeyPem, keyid: 'iss', trustRoot: trusted });
  assert.equal(out.file, 'attestations/issued.iss.dsse.json');
});

test('keygen checks the key id, never replaces a key, and keeps the private key owner-only', { skip: process.platform === 'win32' ? 'file modes' : false }, () => {
  const out = join(tmp(), 'keys');
  for (const bad of ['../evil', 'a/b', '.x', '']) {
    const r = cli(['keygen', '--keyid', bad, '--out', out]);
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /--keyid: /);
  }
  assert.equal(existsSync(out), false);
  assert.equal(cli(['keygen', '--keyid', 'acme', '--out', out]).status, 0);
  assert.equal(statSync(join(out, 'acme.pem')).mode & 0o777, 0o600);
  const pem = readFileSync(join(out, 'acme.pem'), 'utf8');
  const again = cli(['keygen', '--keyid', 'acme', '--out', out]);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /never replaces a key/);
  assert.equal(readFileSync(join(out, 'acme.pem'), 'utf8'), pem);
  // A key id already in the trust root, with its files gone, is still not replaced.
  rmSync(join(out, 'acme.pem'));
  rmSync(join(out, 'acme.pub.pem'));
  assert.equal(cli(['keygen', '--keyid', 'acme', '--out', out]).status, 2);
  assert.equal(existsSync(join(out, 'acme.pem')), false);
});

test('every signing failure exits non-zero with one clear line', () => {
  const dir = minimal();
  const missingKey = cli(['sign', dir, '--key', join(dir, 'no-such.pem'), '--keyid', 'pub']);
  assert.equal(missingKey.status, 1);
  assert.match(missingKey.stderr, /^moca-sign: failed: .*no-such\.pem/m);
  assert.doesNotMatch(missingKey.stderr, /\n\s+at /);
  const badKey = join(dir, 'bad.pem');
  writeFileSync(badKey, 'not a key');
  const r = cli(['sign', dir, '--key', badKey, '--keyid', 'pub']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /^moca-sign: /m);
  assert.equal(existsSync(join(dir, 'attestations')), false);
  const invalid = cli(['sign', join(spec, 'conformance/fixtures/type-missing'), '--key', badKey, '--keyid', 'pub']);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /refusing to attest an invalid package/);
});
