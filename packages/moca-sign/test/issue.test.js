import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackage } from '@openmoca/moca-core';
import { generateKeyPair, signPackage, issueCopy, compareCopy, IssueError } from '../lib/index.js';
import { parseIds, parseRoles, addKey } from '../lib/trust.js';

// moca-spec attestations §3a: issue binds a marked copy; it never marks anything.
const publisher = generateKeyPair();
const issuer = generateKeyPair();
const NODE = (t) => `---\ntype: Lesson\ntitle: ${t}\n---\n\n# ${t}\n\nText.\n`;

async function original({ consent = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-issue-'));
  const manifest = { id: 'https://example.com/t/course', version: '1.0.0', title: 'T' };
  if (consent) manifest.issuedCopies = { issuers: [{ publicKey: issuer.publicKeyPem }], paths: ['content/lessons/'] };
  writeFileSync(join(dir, 'moca.json'), JSON.stringify(manifest));
  mkdirSync(join(dir, 'content', 'lessons'), { recursive: true });
  writeFileSync(join(dir, 'content', 'intro.md'), NODE('Intro'));
  writeFileSync(join(dir, 'content', 'lessons', 'one.md'), NODE('One'));
  await signPackage({ dir, privateKeyPem: publisher.privateKeyPem, keyid: 'pub' });
  return dir;
}

function copyOf(dir) {
  const copy = mkdtempSync(join(tmpdir(), 'moca-issue-copy-'));
  cpSync(dir, copy, { recursive: true });
  return copy;
}

const trustRoot = {
  keys: [
    { keyid: 'pub', publicKey: publisher.publicKeyPem, roles: ['package'] },
    { keyid: 'iss', publicKey: issuer.publicKeyPem, roles: ['issued-copy'], ids: ['https://example.com/t/'] },
  ],
};

test('an issued copy verifies as the publisher\'s, with the changed file named', async () => {
  const dir = await original();
  const copy = copyOf(dir);
  appendFileSync(join(copy, 'content', 'lessons', 'one.md'), '\nMarked.\n');
  const out = await issueCopy({ original: dir, copy, privateKeyPem: issuer.privateKeyPem, keyid: 'iss' });
  assert.deepEqual(out.changedFiles, ['content/lessons/one.md']);
  assert.equal(out.originalDigest, (await readPackage(dir)).digest);
  const r = await readPackage(copy, { trustRoot });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity !== 'info'), []);
  assert.ok(r.capabilities.includes('signed'));
  assert.equal(r.issuedCopy.originalDigest, out.originalDigest);
});

test('the publisher\'s attestations are copied into a copy that lacks them', async () => {
  const dir = await original();
  const copy = copyOf(dir);
  rmSync(join(copy, 'attestations'), { recursive: true });
  appendFileSync(join(copy, 'content', 'lessons', 'one.md'), '\nMarked.\n');
  const out = await issueCopy({ original: dir, copy, privateKeyPem: issuer.privateKeyPem, keyid: 'iss' });
  assert.deepEqual(out.copied, ['attestations/package.pub.dsse.json']);
  assert.ok((await readPackage(copy, { trustRoot })).capabilities.includes('signed'));
});

test('a change the rules or the publisher do not allow is refused, with every problem', async () => {
  const dir = await original();
  const copy = copyOf(dir);
  appendFileSync(join(copy, 'content', 'intro.md'), '\nMarked.\n');
  writeFileSync(join(copy, 'content', 'extra.md'), NODE('Extra'));
  const manifest = JSON.parse(readFileSync(join(copy, 'moca.json'), 'utf8'));
  writeFileSync(join(copy, 'moca.json'), JSON.stringify({ ...manifest, title: 'Changed' }));
  await assert.rejects(compareCopy({ original: dir, copy }), (err) => err instanceof IssueError
    && /extra\.md is in the copy but not the original/.test(err.message)
    && /moca\.json changed: only files under content\/ or media\/ may change/.test(err.message)
    && /intro\.md changed, but issuedCopies\.paths does not allow it/.test(err.message));
});

test('a package without issuedCopies cannot be issued, and an unchanged copy has nothing to issue', async () => {
  const closed = await original({ consent: false });
  const copy = copyOf(closed);
  appendFileSync(join(copy, 'content', 'lessons', 'one.md'), '\nMarked.\n');
  await assert.rejects(compareCopy({ original: closed, copy }), /no issuedCopies/);
  const open = await original();
  await assert.rejects(compareCopy({ original: open, copy: copyOf(open) }), /nothing to issue/);
});

test('the issued-copy role is never a default, and needs ids', () => {
  assert.deepEqual(parseRoles(undefined), ['package', 'review']);
  assert.deepEqual(parseRoles('issued-copy'), ['issued-copy']);
  assert.throws(() => parseIds(undefined, ['issued-copy']), /needs --ids/);
  const { doc } = addKey({}, { keyid: 'iss', publicKey: issuer.publicKeyPem, roles: ['issued-copy'], ids: parseIds('https://example.com/t/', ['issued-copy']) });
  assert.deepEqual(doc.keys[0].ids, ['https://example.com/t/']);
});
