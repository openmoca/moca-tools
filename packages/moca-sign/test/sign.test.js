import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackage } from '@openmoca/moca-core';
import { generateKeyPair, trustRootFor, signPackage, reviewNodes, verifyPackage } from '../lib/index.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'moca-sign-'));
  const spec = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
  cpSync(join(spec, 'examples/minimal'), dir, { recursive: true });
  return dir;
}

const publisher = generateKeyPair();
const reviewer = generateKeyPair();
const trustRoot = {
  keys: [
    { ...trustRootFor({ keyid: 'pub', publicKeyPem: publisher.publicKeyPem }).keys[0], roles: ['package'] },
    { ...trustRootFor({ keyid: 'rev', publicKeyPem: reviewer.publicKeyPem }).keys[0], roles: ['review'] },
  ],
};

test('sign then verify; signing does not change the digest', async () => {
  const dir = fixture();
  const before = (await readPackage(dir)).digest;
  const out = await signPackage({ dir, privateKeyPem: publisher.privateKeyPem, keyid: 'pub' });
  assert.equal(out.digest, before);
  assert.equal((await readPackage(dir)).digest, before);
  const v = await verifyPackage({ dir, trustRoot });
  assert.equal(v.ok, true);
  assert.deepEqual(v.signers, ['pub']);
});

test('DSSE signatures are deterministic, so derived fixtures are reproducible', async () => {
  const a = fixture();
  const b = fixture();
  const fa = await signPackage({ dir: a, privateKeyPem: publisher.privateKeyPem, keyid: 'pub' });
  const fb = await signPackage({ dir: b, privateKeyPem: publisher.privateKeyPem, keyid: 'pub' });
  assert.equal(readFileSync(join(a, fa.file), 'utf8'), readFileSync(join(b, fb.file), 'utf8'));
});

test('a review attests exact node bytes and goes stale when the node changes', async () => {
  const dir = fixture();
  await signPackage({ dir, privateKeyPem: publisher.privateKeyPem, keyid: 'pub' });
  await reviewNodes({ dir, nodes: ['hello.md'], reviewer: 'human:jane', outcome: 'accurate', reviewedAt: '2026-09-01T00:00:00Z', privateKeyPem: reviewer.privateKeyPem, keyid: 'rev' });
  let r = await readPackage(dir, { trustRoot });
  assert.deepEqual(r.capabilities.sort(), ['core', 'reviewed', 'signed']);
  assert.equal(r.reviewsByFile.get('content/hello.md')[0].reviewer, 'human:jane');

  // Editing a reviewed node after the fact: the package attestation fails and the review is outdated.
  const node = join(dir, 'content/hello.md');
  writeFileSync(node, readFileSync(node, 'utf8').replace('smallest', 'tiniest'));
  r = await readPackage(dir, { trustRoot });
  const codes = r.diagnostics.map((d) => d.code).sort();
  assert.deepEqual(codes, ['A006_REVIEW_OUTDATED', 'A008_PACKAGE_DIGEST_MISMATCH']);
  assert.deepEqual(r.capabilities, ['core']);
});

test('keys are only trusted for their role', async () => {
  const dir = fixture();
  await signPackage({ dir, privateKeyPem: reviewer.privateKeyPem, keyid: 'rev' });
  const r = await readPackage(dir, { trustRoot });
  assert.ok(r.diagnostics.some((d) => d.code === 'A002_ATTESTATION_INVALID'));
  assert.equal(r.signers.length, 0);
});

test('reviewing a path that is not in the package is refused', async () => {
  const dir = fixture();
  await assert.rejects(reviewNodes({ dir, nodes: ['nope.md'], reviewer: 'human:x', outcome: 'accurate', privateKeyPem: reviewer.privateKeyPem, keyid: 'rev' }));
});
