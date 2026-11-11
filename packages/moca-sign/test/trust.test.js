import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { validateAgainst } from '@openmoca/moca-core';
import {
  generateKeyPair, signPackage, verifyPackage,
  addKey, addSigstoreIdentity, removeEntry, describeTrustRoot, checkPublicKey, parseRoles, parseExpires, TrustRootError,
} from '../lib/index.js';

const bin = fileURLToPath(new URL('../bin/moca-sign.js', import.meta.url));
const cli = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8' });
const tmp = () => mkdtempSync(join(tmpdir(), 'moca-trust-'));
const ACTIONS = 'https://token.actions.githubusercontent.com';
const WORKFLOW = 'https://github.com/acme/kb/.github/workflows/publish.yml@refs/heads/main';

test('addKey adds, then replaces by keyid, and the result is a valid trust root', () => {
  const { publicKeyPem } = generateKeyPair();
  let { doc, replaced } = addKey({}, { keyid: 'acme', publicKey: publicKeyPem, roles: ['package'], expires: '2027-01-01T00:00:00Z' });
  assert.equal(replaced, false);
  assert.deepEqual(validateAgainst('trustRoot', doc), []);
  ({ doc, replaced } = addKey(doc, { keyid: 'acme', publicKey: publicKeyPem, identity: 'Acme' }));
  assert.equal(replaced, true);
  assert.equal(doc.keys.length, 1);
  assert.equal(doc.keys[0].identity, 'Acme');
  // Attestations §6 (0.6): a trust root always lists roles; none given means both.
  assert.deepEqual(doc.keys[0].roles, ['package', 'review']);
});

test('addSigstoreIdentity adds, then replaces by issuer and subject, and keeps the keys', () => {
  const { publicKeyPem } = generateKeyPair();
  let { doc } = addKey({}, { keyid: 'k', publicKey: publicKeyPem });
  let replaced;
  ({ doc, replaced } = addSigstoreIdentity(doc, { issuer: ACTIONS, subject: WORKFLOW, roles: ['package'] }));
  assert.equal(replaced, false);
  ({ doc, replaced } = addSigstoreIdentity(doc, { issuer: ACTIONS, subject: WORKFLOW }));
  assert.equal(replaced, true);
  assert.equal(doc.sigstore.identities.length, 1);
  assert.equal(doc.keys.length, 1);
  assert.deepEqual(validateAgainst('trustRoot', doc), []);
  assert.throws(() => addSigstoreIdentity(doc, { issuer: 'token.actions', subject: WORKFLOW }), TrustRootError);
});

test('removeEntry removes a key or an identity, and says when there was none', () => {
  const { publicKeyPem } = generateKeyPair();
  let { doc } = addKey({}, { keyid: 'k', publicKey: publicKeyPem });
  ({ doc } = addSigstoreIdentity(doc, { issuer: ACTIONS, subject: WORKFLOW }));
  let removed;
  ({ doc, removed } = removeEntry(doc, { keyid: 'k' }));
  assert.equal(removed, true);
  assert.equal(doc.keys.length, 0);
  ({ removed } = removeEntry(doc, { keyid: 'k' }));
  assert.equal(removed, false);
  ({ doc, removed } = removeEntry(doc, { issuer: ACTIONS, subject: WORKFLOW }));
  assert.equal(removed, true);
  assert.equal(doc.sigstore.identities.length, 0);
});

test('checkPublicKey accepts Ed25519 public keys, and refuses other key types, private keys and junk', () => {
  const ed = generateKeyPair();
  assert.equal(checkPublicKey(ed.publicKeyPem).type, 'ed25519');
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => checkPublicKey(ec), /EC key; MOCA DSSE keys are Ed25519/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => checkPublicKey(rsa), /RSA key/);
  assert.throws(() => checkPublicKey(ed.privateKeyPem), /private key/);
  assert.throws(() => checkPublicKey('not a key'), /not a PEM public key/);
});

test('roles and expiry dates are checked', () => {
  assert.deepEqual(parseRoles(undefined), ['package', 'review']);
  assert.deepEqual(parseRoles('package, review,package'), ['package', 'review']);
  assert.throws(() => parseRoles('publish'), TrustRootError);
  assert.equal(parseExpires('2027-01-01'), '2027-01-01T00:00:00Z');
  assert.equal(parseExpires('2027-01-01T12:30:00+01:00'), '2027-01-01T11:30:00Z');
  assert.throws(() => parseExpires('next year'), TrustRootError);
});

test('describeTrustRoot lists keys and identities, and marks expired keys', () => {
  const { publicKeyPem } = generateKeyPair();
  let { doc } = addKey({}, { keyid: 'old', publicKey: publicKeyPem, expires: '2020-01-01T00:00:00Z' });
  ({ doc } = addSigstoreIdentity(doc, { issuer: ACTIONS, subject: WORKFLOW, roles: ['package'] }));
  const lines = describeTrustRoot(doc, new Date('2026-11-03T00:00:00Z'));
  assert.match(lines[0], /^key\s+package,review\s+old \(old, EXPIRED 2020-01-01T00:00:00Z\)$/);
  assert.match(lines[1], /^sigstore\s+package\s+https:\/\/github\.com\/acme/);
});

test('cli: a reader trusts a publisher\'s public key, and its signature then verifies', async () => {
  const work = tmp();
  const pkg = join(work, 'kb');
  const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
  cpSync(join(spec, 'examples/minimal'), pkg, { recursive: true });

  // The publisher makes a key and signs; the reader receives only the public key.
  execFileSync(process.execPath, [bin, 'keygen', '--keyid', 'acme', '--out', join(work, 'publisher')]);
  const privateKeyPem = readFileSync(join(work, 'publisher', 'acme.pem'), 'utf8');
  await signPackage({ dir: pkg, privateKeyPem, keyid: 'acme' });

  const root = join(work, 'reader', 'trust-root.json');
  mkdirSync(join(work, 'reader'), { recursive: true });
  const before = await verifyPackage({ dir: pkg, trustRoot: { keys: [] } });
  assert.equal(before.ok, false);

  const add = cli(['trust', 'add', root, '--keyid', 'acme', '--public-key', join(work, 'publisher', 'acme.pub.pem'),
    '--identity', 'Acme publishing key', '--roles', 'package', '--expires', '2099-01-01']);
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /Added key acme in /);

  const after = await verifyPackage({ dir: pkg, trustRoot: root });
  assert.equal(after.ok, true);
  assert.deepEqual(after.signers, ['Acme publishing key']);

  const list = cli(['trust', 'list', root]);
  assert.match(list.stdout, /^key\s+package\s+acme \(Acme publishing key, expires 2099-01-01T00:00:00Z\)$/m);

  // Trusted only for reviews, the same key no longer makes the package signed.
  assert.equal(cli(['trust', 'add', root, '--keyid', 'acme', '--public-key', join(work, 'publisher', 'acme.pub.pem'), '--roles', 'review']).status, 0);
  assert.equal((await verifyPackage({ dir: pkg, trustRoot: root })).ok, false);

  assert.equal(cli(['trust', 'remove', root, '--keyid', 'acme']).status, 0);
  assert.equal(JSON.parse(readFileSync(root, 'utf8')).keys.length, 0);
});

test('cli: refuses what does not belong, and leaves the file as it was', () => {
  const work = tmp();
  const root = join(work, 'trust-root.json');
  const { privateKeyPem, publicKeyPem } = generateKeyPair();
  writeFileSync(join(work, 'k.pem'), privateKeyPem);
  writeFileSync(join(work, 'k.pub.pem'), publicKeyPem);

  const priv = cli(['trust', 'add', root, '--keyid', 'k', '--public-key', join(work, 'k.pem')]);
  assert.equal(priv.status, 2);
  assert.match(priv.stderr, /private key/);
  assert.equal(existsSync(root), false);

  const both = cli(['trust', 'add', root, '--keyid', 'k', '--public-key', join(work, 'k.pub.pem'), '--issuer', ACTIONS, '--subject', WORKFLOW]);
  assert.equal(both.status, 2);
  const neither = cli(['trust', 'add', root]);
  assert.equal(neither.status, 2);

  assert.equal(cli(['trust', 'add', root, '--issuer', ACTIONS, '--subject', WORKFLOW, '--roles', 'package']).status, 0);
  const missing = cli(['trust', 'remove', root, '--keyid', 'nobody']);
  assert.equal(missing.status, 2);

  writeFileSync(root, '{ "keys": [ { "keyid": "x" } ] }');
  const invalid = cli(['trust', 'list', root]);
  assert.equal(invalid.status, 2);
  assert.match(invalid.stderr, /not a valid trust root/);
});

test('cli: keygen still writes a trust root readers can use, now through the same code', () => {
  const work = tmp();
  const out = join(work, 'keys');
  execFileSync(process.execPath, [bin, 'keygen', '--keyid', 'a', '--out', out, '--roles', 'package', '--expires', '2099-01-01']);
  execFileSync(process.execPath, [bin, 'keygen', '--keyid', 'b', '--out', out, '--identity', 'Bea', '--roles', 'review']);
  const doc = JSON.parse(readFileSync(join(out, 'trust-root.json'), 'utf8'));
  assert.deepEqual(validateAgainst('trustRoot', doc), []);
  assert.deepEqual(doc.keys.map((k) => [k.keyid, k.identity, k.roles, k.expires]), [
    ['a', 'a', ['package'], '2099-01-01T00:00:00Z'],
    ['b', 'Bea', ['review'], undefined],
  ]);
});

test('checkPublicKey refuses small-order and mixed-order Ed25519 keys (attestations §5)', () => {
  const spki = (hex) => `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]).toString('base64')}\n-----END PUBLIC KEY-----\n`;
  // The identity point, and a point of order 8.
  for (const hex of ['01' + '00'.repeat(31), 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a']) {
    assert.throws(() => checkPublicKey(spki(hex)), /small-order or mixed-order/);
  }
});
