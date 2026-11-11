import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { openSource } from '@openmoca/moca-core';
import { createLintHandler, lintArchive, LINT_NOTES } from '../lib/http.js';

const repo = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
const BASE = 'https://tools.example/lint';

/** A package directory as .moca archive bytes. */
function archiveOf(dir) {
  const source = openSource(dir);
  const zip = new AdmZip();
  for (const e of source.list()) zip.addFile(e.path, source.read(e.path));
  return zip.toBuffer();
}

const post = (body, query = '') => new Request(`${BASE}${query}`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body });

test('lints a posted archive as the reference Reader reads it, and says what it cannot check', async () => {
  const handler = createLintHandler();
  const response = await handler(post(archiveOf(join(repo, 'examples/support-kb'))));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.package.id, 'https://example.com/moca/support-kb');
  assert.match(body.package.digest, /^sha256:/);
  assert.equal(body.summary.error, 0);
  assert.deepEqual(body.notes, [...LINT_NOTES]);
});

test('reports a broken package with the Reader\'s codes', async () => {
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('no manifest here'));
  const body = await (await createLintHandler()(post(zip.toBuffer()))).json();
  assert.equal(body.ok, false);
  assert.ok(body.diagnostics.some((d) => d.code === 'T002_MANIFEST_NOT_FOUND'));
});

test('bytes that are not an archive come back as T003, not as a server error', async () => {
  const response = await createLintHandler()(post(new TextEncoder().encode('not a zip at all')));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.package, null);
  assert.equal(body.diagnostics[0].code, 'T003_ARCHIVE_REJECTED');
});

test('an archive with too many entries is rejected before anything is inflated', async () => {
  const zip = new AdmZip();
  for (let i = 0; i < 20; i++) zip.addFile(`content/${i}.md`, Buffer.from('x'));
  const lint = await lintArchive(zip.toBuffer(), { maxEntries: 10 });
  assert.equal(lint.diagnostics[0].code, 'T003_ARCHIVE_REJECTED');
  assert.match(lint.diagnostics[0].message, /entries/);
});

test('an archive that expands past the limit is rejected (a zip bomb)', async () => {
  const zip = new AdmZip();
  // 2 MB of zeros compresses to a few KB.
  zip.addFile('content/big.md', Buffer.alloc(2 * 1024 * 1024));
  const bytes = zip.toBuffer();
  assert.ok(bytes.byteLength < 64 * 1024);
  const lint = await lintArchive(bytes, { maxBytes: 1024 * 1024 });
  assert.equal(lint.diagnostics[0].code, 'T003_ARCHIVE_REJECTED');
  assert.match(lint.diagnostics[0].message, /expands/);
});

test('answers SARIF on request', async () => {
  const response = await createLintHandler()(post(archiveOf(join(repo, 'examples/support-kb')), '?format=sarif'));
  const sarif = await response.json();
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].tool.driver.name, 'moca-lint');
});

test('refuses other paths, methods, formats, empty and big bodies with stable codes', async () => {
  const handler = createLintHandler({ maxBodyBytes: 100 });
  const code = async (r) => [r.status, (await r.json()).error.code];
  assert.deepEqual(await code(await handler(new Request('https://tools.example/other', { method: 'POST' }))), [404, 'not_found']);
  assert.deepEqual(await code(await handler(new Request(BASE))), [405, 'method_not_allowed']);
  assert.deepEqual(await code(await handler(post(new Uint8Array(10), '?format=xml'))), [400, 'unknown_format']);
  assert.deepEqual(await code(await handler(post(new Uint8Array(0)))), [400, 'empty_body']);
  assert.deepEqual(await code(await handler(post(new Uint8Array(500)))), [413, 'body_too_large']);
});

test('the host rate limit refuses before the body is read', async () => {
  const request = post(new Uint8Array(10));
  const response = await createLintHandler({ allow: () => false })(request);
  assert.equal(response.status, 429);
  assert.equal(request.bodyUsed, false);
});

test('allows any origin, without credentials', async () => {
  const preflight = await createLintHandler()(new Request(BASE, { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
});

test('an archive whose sizes lie is reported, not a server error', async () => {
  const zip = new AdmZip();
  zip.addFile('moca.json', Buffer.from('{}'));
  zip.addFile('content/big.md', Buffer.alloc(4 * 1024 * 1024, 0x61));
  const bytes = zip.toBuffer();
  const name = Buffer.from('content/big.md');
  for (let i = 0; i < bytes.length - 4; i++) {
    const sig = bytes.readUInt32LE(i);
    if (sig === 0x04034b50 && bytes.subarray(i + 30, i + 30 + name.length).equals(name)) bytes.writeUInt32LE(100, i + 22);
    if (sig === 0x02014b50 && bytes.subarray(i + 46, i + 46 + name.length).equals(name)) bytes.writeUInt32LE(100, i + 24);
  }
  const response = await createLintHandler()(post(bytes));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.ok(body.diagnostics.some((d) => d.code === 'P002_UNREADABLE_ENTRY'));
});
