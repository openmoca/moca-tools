// --force replaces only a sidecar, through a staged copy; --envelope writes then renames.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackage, bindSidecar } from '@openmoca/moca-core';
import { encryptPackage } from '@openmoca/moca-sign';
import { buildSidecar, addEnvelopeIndex } from '../lib/index.js';

const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
const kb = join(spec, 'examples/support-kb');
const tmp = () => mkdtempSync(join(tmpdir(), 'moca-index-force-'));

test('--force refuses a folder that is not a sidecar, and leaves it as it was', async () => {
  const dir = tmp();
  const out = join(dir, 'notes');
  mkdirSync(out);
  writeFileSync(join(out, 'keep.txt'), 'mine');
  await assert.rejects(buildSidecar({ pkg: kb, out, force: true }), /not a sidecar/);
  assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'mine');
  assert.deepEqual(readdirSync(dir), ['notes']);
  const file = join(dir, 'notes.mocai');
  writeFileSync(file, 'not an archive');
  await assert.rejects(buildSidecar({ pkg: kb, out: file, zip: true, force: true }), /not a sidecar/);
  assert.equal(readFileSync(file, 'utf8'), 'not an archive');
});

test('--force replaces a previous sidecar, folder or archive, and leaves nothing else beside it', async () => {
  const pkg = await readPackage(kb);
  for (const zip of [false, true]) {
    const dir = tmp();
    const out = join(dir, zip ? 'kb.mocai' : 'kb-index');
    await buildSidecar({ pkg: kb, out, zip });
    await assert.rejects(buildSidecar({ pkg: kb, out, zip }), /already exists/);
    await buildSidecar({ pkg: kb, out, zip, force: true, chunker: 'headings' });
    assert.equal(bindSidecar(out, pkg).usable, true);
    assert.deepEqual(readdirSync(dir), [zip ? 'kb.mocai' : 'kb-index']);
  }
});

test('an empty folder is used without --force', async () => {
  const out = join(tmp(), 'empty');
  mkdirSync(out);
  await buildSidecar({ pkg: kb, out });
  assert.ok(existsSync(join(out, 'index.json')));
});

test('--envelope leaves no temporary file, and checks the package when a passphrase opens the envelope', async () => {
  const dir = tmp();
  const env = join(dir, 'kb.mocae');
  await encryptPackage({ pkg: kb, out: env, passphrase: 'pw', workFactor: 15, outline: [] });
  // No outline: the passphrase opens the envelope, and the package inside is not this one.
  await assert.rejects(addEnvelopeIndex({ pkg: join(spec, 'conformance/fixtures/valid-minimal'), envelope: env, passphrase: 'pw', workFactor: 15 }), /holds a package with digest/);
  const before = readFileSync(env);
  await assert.rejects(addEnvelopeIndex({ pkg: kb, envelope: env, passphrase: 'wrong', workFactor: 15 }), /does not open/);
  assert.deepEqual(readFileSync(env), before);
  const r = await addEnvelopeIndex({ pkg: kb, envelope: env, passphrase: 'pw', workFactor: 15 });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(readdirSync(dir), ['kb.mocae']);
});

test('--envelope with recipients and no outline warns that it cannot check the package', async () => {
  const keys = join(spec, 'conformance/fixtures/envelopes/keys');
  const recipient = readFileSync(join(keys, 'INSECURE-test.txt'), 'utf8').match(/public key: (age1\w+)/)[1];
  const env = join(tmp(), 'kb.mocae');
  await encryptPackage({ pkg: kb, out: env, recipients: [recipient], outline: [] });
  const r = await addEnvelopeIndex({ pkg: kb, envelope: env, recipients: [recipient] });
  assert.match(r.warnings[0], /cannot check/);
});
