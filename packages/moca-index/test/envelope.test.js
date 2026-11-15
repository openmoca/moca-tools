// moca-index build --envelope (moca-spec encrypted packages §6): index.age, bound through the Reader's key provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { readPackage, bindEnvelopeSidecar } from '@openmoca/moca-core';
import { ageDecryptor } from '@openmoca/moca-core/age';
import { encryptPackage } from '@openmoca/moca-sign';
import { addEnvelopeIndex } from '../lib/index.js';

const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
const keys = join(spec, 'conformance/fixtures/envelopes/keys');
const idsIn = (f) => readFileSync(join(keys, f), 'utf8').split('\n').filter((l) => l.startsWith('AGE-SECRET-KEY-1'));
const recipient = readFileSync(join(keys, 'INSECURE-test.txt'), 'utf8').match(/public key: (age1\w+)/)[1];
const supportKb = join(spec, 'examples/support-kb');
const opener = (file) => ({ decryptor: ageDecryptor, keyProvider: () => ({ identities: idsIn(file) }) });

test('index.age is added, stored, and binds through the same key provider', async () => {
  const env = join(mkdtempSync(join(tmpdir(), 'moca-index-env-')), 'kb.mocae');
  await encryptPackage({ pkg: supportKb, out: env, recipients: [recipient] });
  const r = await addEnvelopeIndex({ pkg: supportKb, envelope: env, recipients: [recipient] });
  assert.ok(r.items > 0);
  assert.equal(new AdmZip(env).getEntry('index.age').header.method, 0);
  const pkg = await readPackage(env, opener('INSECURE-test.txt'));
  assert.equal(pkg.valid, true);
  const bound = await bindEnvelopeSidecar(env, pkg, opener('INSECURE-test.txt'));
  assert.equal(bound.usable, true);
  assert.equal(bound.chunks.length, r.items);
  const wrong = await bindEnvelopeSidecar(env, pkg, opener('INSECURE-other.txt'));
  assert.deepEqual(wrong.diagnostics.map((d) => d.code), ['E002_DECRYPTION_FAILED']);
});

test('--envelope refuses another package\'s envelope, and a second index without --force', async () => {
  const env = join(mkdtempSync(join(tmpdir(), 'moca-index-env-')), 'kb.mocae');
  await encryptPackage({ pkg: supportKb, out: env, recipients: [recipient] });
  await assert.rejects(addEnvelopeIndex({ pkg: join(spec, 'conformance/fixtures/valid-minimal'), envelope: env, recipients: [recipient] }), /outline id/);
  await addEnvelopeIndex({ pkg: supportKb, envelope: env, recipients: [recipient] });
  await assert.rejects(addEnvelopeIndex({ pkg: supportKb, envelope: env, recipients: [recipient] }), /already has an index.age/);
  await addEnvelopeIndex({ pkg: supportKb, envelope: env, recipients: [recipient], force: true });
});
