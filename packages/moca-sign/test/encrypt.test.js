// moca-sign encrypt and decrypt (moca-spec encrypted packages): checked against the Go age CLI and the Reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { readPackage } from '@openmoca/moca-core';
import { ageDecryptor } from '@openmoca/moca-core/age';
import { ageEncrypt, decodeRecipient, encryptPackage, decryptEnvelope, EncryptError } from '../lib/index.js';

const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
const keyFile = join(spec, 'conformance/fixtures/envelopes/keys/INSECURE-test.txt');
const recipient = readFileSync(keyFile, 'utf8').match(/public key: (age1\w+)/)[1];
const identities = readFileSync(keyFile, 'utf8').split('\n').filter((l) => l.startsWith('AGE-SECRET-KEY-1'));
const supportKb = join(spec, 'examples/support-kb');
const structured = join(spec, 'conformance/fixtures/structure-procedure');
const goAge = spawnSync('age', ['--version']).status === 0;
const tmp = () => mkdtempSync(join(tmpdir(), 'moca-sign-enc-'));
const opener = (key) => ({ decryptor: ageDecryptor, keyProvider: () => key });

test('the Go age CLI decrypts what ageEncrypt writes, for every chunk boundary', { skip: goAge ? false : 'the Go age CLI is not installed' }, () => {
  for (const size of [0, 1, 65535, 65536, 65537, 131072, 200000]) {
    const plain = Buffer.alloc(size, size % 251);
    const sealed = ageEncrypt(plain, { recipients: [recipient] });
    const go = spawnSync('age', ['--decrypt', '-i', keyFile], { input: sealed });
    assert.equal(go.status, 0, `size ${size}: ${go.stderr}`);
    assert.ok(go.stdout.equals(plain), `size ${size}: the plaintexts differ`);
    // And the Reader's own decryptor agrees.
    assert.ok(Buffer.from(ageDecryptor.decrypt(sealed, ageDecryptor.parseHeader(sealed), { identities })).equals(plain));
  }
  const pw = ageEncrypt(Buffer.from('hello'), { passphrase: 'pw', workFactor: 10 });
  const go = spawnSync('age', ['--decrypt', '-j', 'batchpass'], { input: pw, env: { ...process.env, AGE_PASSPHRASE: 'pw' } });
  assert.equal(go.stdout.toString(), 'hello');
});

test('recipients are bech32-checked, and a passphrase file has no other recipient', () => {
  assert.equal(decodeRecipient(recipient).length, 32);
  assert.throws(() => decodeRecipient(`${recipient.slice(0, -1)}q`), EncryptError);
  assert.throws(() => ageEncrypt(Buffer.alloc(1), { recipients: [recipient], passphrase: 'x' }), EncryptError);
  assert.throws(() => ageEncrypt(Buffer.alloc(1), {}), EncryptError);
});

test('encrypt -> Reader open -> decrypt keeps the digest; the outline is what was chosen', async () => {
  const dir = tmp();
  const plain = await readPackage(supportKb);
  const env = join(dir, 'kb.moca.enc');
  const out = await encryptPackage({ pkg: supportKb, out: env, recipients: [recipient], outline: ['id', 'version', 'title', 'license'] });
  assert.equal(out.digest, plain.digest);
  assert.deepEqual(Object.keys(out.outline), ['id', 'version', 'title', 'license']);
  const opened = await readPackage(env, opener({ identities }));
  assert.equal(opened.valid, true);
  assert.equal(opened.digest, plain.digest);
  assert.deepEqual(opened.envelope, { format: 'moca-enc-v1', opened: true });
  const closed = await readPackage(env);
  assert.deepEqual(closed.diagnostics.map((d) => d.code), ['E001_ENCRYPTED_NO_KEY']);
  const back = join(dir, 'kb.moca');
  const d = await decryptEnvelope({ envelope: env, out: back, identities });
  assert.equal(d.digest, plain.digest);
  assert.equal((await readPackage(back)).digest, plain.digest);
  // package.age is stored, as the layout requires.
  assert.equal(new AdmZip(env).getEntry('package.age').header.method, 0);
});

test('a passphrase envelope, no outline, and the structure copy', async () => {
  const dir = tmp();
  const env = join(dir, 'p.moca.enc');
  const out = await encryptPackage({ pkg: structured, out: env, passphrase: 'pw', workFactor: 10, outline: [], structure: true });
  assert.equal(out.outline, undefined);
  assert.match(out.warnings[0], /concept graph/);
  const marker = JSON.parse(new AdmZip(env).getEntry('moca-enc.json').getData().toString());
  assert.deepEqual(marker, { format: 'moca-enc-v1' });
  const opened = await readPackage(env, opener({ passphrase: 'pw' }));
  assert.equal(opened.valid, true);
  assert.ok(opened.capabilities.includes('structured'));
});

test('the cover copy and a catalogue outline open, and the copy is checked against the inner cover', async () => {
  const catalogue = join(spec, 'conformance/fixtures/catalogue-valid');
  const env = join(tmp(), 'c.moca.enc');
  const out = await encryptPackage({ pkg: catalogue, out: env, recipients: [recipient], outline: ['id', 'version', 'title', 'translations', 'tags'], cover: true });
  assert.ok(out.warnings.some((w) => /outline\/cover\.webp is readable/.test(w)));
  const zip = new AdmZip(env);
  assert.ok(zip.getEntry('outline/cover.webp').getData().equals(readFileSync(join(catalogue, 'media/cover.webp'))));
  assert.deepEqual(out.outline.tags, ['customer support', 'refunds', 'returns']);
  const opened = await readPackage(env, opener({ identities }));
  assert.equal(opened.envelope.opened, true);
  assert.equal(opened.valid, true);
});

test('--cover refuses a package with no cover', async () => {
  await assert.rejects(encryptPackage({ pkg: supportKb, out: join(tmp(), 'n.moca.enc'), recipients: [recipient], cover: true }), /no images entry with role cover/);
});

test('encrypt refuses an invalid package, an envelope, an unknown outline field and an existing output', async () => {
  const dir = tmp();
  await assert.rejects(encryptPackage({ pkg: join(spec, 'conformance/fixtures/type-missing'), out: join(dir, 'a'), recipients: [recipient] }), /not valid/);
  await assert.rejects(encryptPackage({ pkg: join(spec, 'conformance/fixtures/envelopes/x25519.moca.enc'), out: join(dir, 'b'), recipients: [recipient] }), /already an envelope/);
  await assert.rejects(encryptPackage({ pkg: supportKb, out: join(dir, 'c'), recipients: [recipient], outline: ['nodes'] }), /not an outline field/);
  writeFileSync(join(dir, 'd'), '');
  await assert.rejects(encryptPackage({ pkg: supportKb, out: join(dir, 'd'), recipients: [recipient] }), /already exists/);
});

test('decrypt refuses a wrong key and writes nothing', async () => {
  const dir = tmp();
  const env = join(dir, 'kb.moca.enc');
  await encryptPackage({ pkg: supportKb, out: env, recipients: [recipient] });
  const other = readFileSync(join(spec, 'conformance/fixtures/envelopes/keys/INSECURE-other.txt'), 'utf8').split('\n').filter((l) => l.startsWith('AGE-SECRET-KEY-1'));
  await assert.rejects(decryptEnvelope({ envelope: env, out: join(dir, 'x.moca'), identities: other }), /E002_DECRYPTION_FAILED/);
  assert.equal(existsSync(join(dir, 'x.moca')), false);
});

test('the CLI reads a passphrase only from the environment', () => {
  const dir = tmp();
  const bin = fileURLToPath(new URL('../bin/moca-sign.js', import.meta.url));
  const r = spawnSync(process.execPath, [bin, 'encrypt', supportKb, '-o', join(dir, 'p.moca.enc'), '--passphrase-env', 'MOCA_TEST_PW', '--work-factor', '10'], { env: { ...process.env, MOCA_TEST_PW: 'pw' } });
  assert.equal(r.status, 0, r.stderr.toString());
  const missing = spawnSync(process.execPath, [bin, 'encrypt', supportKb, '-o', join(dir, 'q.moca.enc'), '--passphrase-env', 'MOCA_TEST_UNSET']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr.toString(), /MOCA_TEST_UNSET is not set/);
});

