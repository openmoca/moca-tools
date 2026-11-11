import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPackage, bindSidecar, Library, Search, DenseBackend } from '@openmoca/moca-core';
import { buildSidecar, chunkRepresentation, splitBySize } from '../lib/index.js';

const repo = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
const kb = join(repo, 'examples/support-kb');

test('builds a sidecar bound to the package digest that a Reader accepts', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'moca-index-')), 'kb.moca.idx');
  const built = await buildSidecar({ pkg: kb, out, chunker: 'headings' });
  const pkg = await readPackage(kb);
  assert.equal(built.digest, pkg.digest);
  const bound = bindSidecar(out, pkg);
  assert.equal(bound.usable, true);
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.equal(index.target.digest, pkg.digest);
  assert.equal(index.storage.format, 'moca-jsonl-v1');
});

test('chunk offsets are byte offsets into the node file', async () => {
  const pkg = await readPackage(kb);
  const rep = pkg.nodes.find((n) => n.path === 'refund-window.md').representations.find((r) => r.locale === 'fr');
  const file = readFileSync(join(kb, rep.file));
  for (const c of chunkRepresentation(rep, 'headings')) {
    assert.equal(file.subarray(c.start, c.end).toString('utf8'), c.text);
  }
});

test('a zipped sidecar works and search uses its chunks', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'moca-index-')), 'kb.moca.idx.zip');
  await buildSidecar({ pkg: kb, out, zip: true, chunker: 'headings' });
  const pkg = await readPackage(kb);
  const bound = bindSidecar(out, pkg);
  assert.equal(bound.usable, true);
  const hits = new Library().add(pkg, { chunks: bound.chunks }).search('refund window carrier');
  assert.equal(hits[0].node.path, 'refund-window.md');
  assert.ok(hits[0].span.end > hits[0].span.start);
});

test('a sidecar is stale as soon as the package changes', async () => {
  const pkg = await readPackage(kb);
  const out = join(mkdtempSync(join(tmpdir(), 'moca-index-')), 'kb.moca.idx');
  await buildSidecar({ pkg: kb, out });
  const changed = { ...pkg, digest: `sha256:${'f'.repeat(64)}` };
  assert.equal(bindSidecar(out, changed).diagnostics[0].code, 'S003_SIDECAR_STALE');
});

const bagOfWords = (name = 'bow', dimensions = 8) => ({
  name,
  dimensions,
  embed: async (texts) => texts.map((t) => {
    const v = new Array(dimensions).fill(0);
    for (const w of t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[[...w].reduce((h, c) => (h * 31 + c.codePointAt(0)) >>> 0, 0) % dimensions] += 1;
    return v;
  }),
});

test('with a host embedder the sidecar carries vectors and the model, and dense search needs the same model', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'moca-index-')), 'kb.moca.idx');
  await buildSidecar({ pkg: kb, out, embedder: bagOfWords() });
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.equal(index.indexType, 'hybrid');
  assert.deepEqual(index.model, { name: 'bow', dimensions: 8 });
  const pkg = await readPackage(kb);
  const bound = bindSidecar(out, pkg);
  assert.equal(bound.usable, true);
  assert.ok(bound.chunks.every((c) => c.vector.length === 8));

  const library = new Library().add(pkg, { chunks: bound.chunks, index: bound.index });
  const results = await new Search(library, { backend: new DenseBackend(library, { embedder: bagOfWords() }) }).search('refund window days');
  assert.ok(results.length > 0);
  const other = new DenseBackend(library, { embedder: bagOfWords('other') });
  assert.deepEqual(other.diagnostics.map((d) => d.code), ['S006_MODEL_MISMATCH']);
});

test('chunks are embedded as documents, and declared prefixes are recorded for Readers to compare', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'moca-index-')), 'kb.moca.idx');
  const roles = [];
  const e5 = { ...bagOfWords('e5'), queryPrefix: 'query: ', documentPrefix: 'passage: ' };
  await buildSidecar({ pkg: kb, out, embedder: { ...e5, embed: async (texts, options) => { roles.push(options?.role); return e5.embed(texts); } } });
  assert.deepEqual(roles, ['document']);
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.model, { name: 'e5', dimensions: 8, queryPrefix: 'query: ', documentPrefix: 'passage: ' });

  const pkg = await readPackage(kb);
  const bound = bindSidecar(out, pkg);
  const library = new Library().add(pkg, { chunks: bound.chunks, index: bound.index });
  assert.deepEqual(new DenseBackend(library, { embedder: e5 }).diagnostics, []);
  const nomic = new DenseBackend(library, { embedder: { ...e5, queryPrefix: 'search_query: ' } });
  assert.deepEqual(nomic.diagnostics.map((d) => d.code), ['S006_MODEL_MISMATCH']);
});

test('an embedder that returns the wrong shape is refused', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'moca-index-')), 'kb.moca.idx');
  const bad = { name: 'bad', dimensions: 4, embed: async (texts) => texts.map(() => [1, 2]) };
  await assert.rejects(buildSidecar({ pkg: kb, out, embedder: bad }), /4-dimension vector/);
});

test('--max-chars splits long chunks at breaks, with exact byte offsets and overlap', async () => {
  const body = '# Title\n\n' + Array.from({ length: 40 }, (_, i) => `Paragraph ${i} has some words, café and ✓ in it. Another sentence follows here.`).join('\n\n') + '\n';
  const prefix = '---\ntitle: x\n---\n';
  const file = Buffer.from(prefix + body, 'utf8');
  const rep = { body, bodyOffset: Buffer.byteLength(prefix) };
  const chunks = chunkRepresentation(rep, 'headings', { maxChars: 400, overlap: 60 });
  assert.ok(chunks.length > 5);
  for (const c of chunks) {
    assert.ok(c.text.length <= 400);
    assert.equal(file.subarray(c.start, c.end).toString('utf8'), c.text);
  }
  // Each window ends at a paragraph break and the next one repeats some of it.
  assert.ok(chunks.slice(0, -1).every((c) => c.text.endsWith('\n\n')));
  assert.ok(chunks.slice(1).every((c, i) => c.start < chunks[i].end));
  // The windows cover the whole body.
  assert.equal(chunks[0].start, rep.bodyOffset);
  assert.equal(chunks.at(-1).end, file.length);
});

test('a chunk that fits is kept whole, and a word with no break is cut but never inside a surrogate pair', () => {
  const small = { body: 'short text', bodyOffset: 0 };
  assert.deepEqual(chunkRepresentation(small, 'node', { maxChars: 100 }), chunkRepresentation(small, 'node'));
  const body = '😀'.repeat(150);
  const chunks = splitBySize({ start: 0, end: Buffer.byteLength(body), text: body }, 101);
  assert.equal(chunks.map((c) => c.text).join(''), body);
  assert.ok(chunks.every((c) => !/[\uD800-\uDBFF]$/.test(c.text)));
});

test('the size limit is recorded in index.json, and bad limits are refused', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'moca-index-')), 'kb.moca.idx');
  await buildSidecar({ pkg: kb, out, chunker: 'headings', maxChars: 200, overlap: 20 });
  const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.chunking, { strategy: 'headings-h1-h3', maxChars: 200, overlap: 20 });
  assert.equal(bindSidecar(out, await readPackage(kb)).usable, true);
  await assert.rejects(buildSidecar({ pkg: kb, out, force: true, maxChars: 50 }), /at least 100/);
  await assert.rejects(buildSidecar({ pkg: kb, out, force: true, overlap: 10 }), /needs --max-chars/);
  await assert.rejects(buildSidecar({ pkg: kb, out, force: true, maxChars: 200, overlap: 150 }), /at most half/);
});
