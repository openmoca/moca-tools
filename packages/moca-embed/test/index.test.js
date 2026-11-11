import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDARD_MODELS, findStandardModel, standardEmbedder, installedModels } from '../lib/index.js';

test('the four standard models, each pinned and with its convention', () => {
  assert.deepEqual(STANDARD_MODELS.map((m) => m.id), ['bge-small-en-v1.5', 'nomic-embed-text-v1.5', 'all-MiniLM-L6-v2', 'multilingual-e5-small']);
  for (const m of STANDARD_MODELS) {
    assert.match(m.commit, /^[0-9a-f]{40}$/);
    assert.equal(m.version, 'onnx-q8');
    assert.ok(Object.values(m.files).every((sha) => /^[0-9a-f]{64}$/.test(sha)));
    assert.ok('onnx/model_quantized.onnx' in m.files);
  }
  assert.equal(findStandardModel('BAAI/bge-small-en-v1.5').id, 'bge-small-en-v1.5');
  assert.equal(findStandardModel('BGE-SMALL-EN-V1.5').id, 'bge-small-en-v1.5');
  assert.equal(findStandardModel('nope'), undefined);
});

test('a model that is not installed is refused with the command that installs it', async () => {
  const store = mkdtempSync(join(tmpdir(), 'moca-models-'));
  try {
    await assert.rejects(standardEmbedder('all-MiniLM-L6-v2', store), /run moca-embed models add all-MiniLM-L6-v2/);
    await assert.rejects(standardEmbedder('nope', store), /not a standard model/);
    assert.deepEqual(installedModels(store), []);
  } finally {
    rmSync(store, { recursive: true, force: true });
  }
});

// With MOCA_TEST_MODELS naming a store that holds bge-small-en-v1.5: the embedder runs, and gives unit vectors.
test('bge-small embeds with its convention', { skip: !process.env.MOCA_TEST_MODELS && 'MOCA_TEST_MODELS is not set' }, async () => {
  const embedder = await standardEmbedder('bge-small-en-v1.5', process.env.MOCA_TEST_MODELS);
  assert.equal(embedder.name, 'BAAI/bge-small-en-v1.5');
  const [doc] = await embedder.embed(['Customers may request a full refund within 30 days of delivery.']);
  const [query] = await embedder.embed(['how long do I have to get a refund'], { role: 'query' });
  assert.equal(doc.length, 384);
  assert.ok(Math.abs(Math.hypot(...doc) - 1) < 1e-5);
  assert.ok(doc.reduce((s, x, i) => s + x * query[i], 0) > 0.6);
});
