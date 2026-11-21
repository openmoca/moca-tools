// Model downloads are limited in size and time, hashed as they arrive, and leave nothing behind when they fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addModel } from '../lib/index.js';

const store = () => mkdtempSync(join(tmpdir(), 'moca-embed-dl-'));

/** A fetch that answers every file from `body(signal)`, with optional headers. */
const fakeFetch = (body, headers = {}) => async (_url, { signal }) => new Response(body(signal), { status: 200, headers });

test('a file over the size limit is refused as it arrives, and nothing is installed', async () => {
  const dir = store();
  const chunk = new Uint8Array(1024);
  const endless = () => new ReadableStream({ pull: (c) => c.enqueue(chunk) });
  await assert.rejects(addModel('bge-small-en-v1.5', dir, () => {}, { fetch: fakeFetch(endless), maxFileBytes: 10 * 1024 }), /over the 10240-byte limit/);
  assert.deepEqual(readdirSync(dir), []);
});

test('a declared length over the limit is refused before reading', async () => {
  const dir = store();
  const body = () => new ReadableStream({ start: (c) => c.close() });
  await assert.rejects(addModel('bge-small-en-v1.5', dir, () => {}, { fetch: fakeFetch(body, { 'content-length': '999999' }), maxFileBytes: 1000 }), /999999 bytes, over the 1000-byte limit/);
  assert.deepEqual(readdirSync(dir), []);
});

test('a download that stalls is stopped, and nothing is installed', async () => {
  const dir = store();
  const stalled = (signal) => new ReadableStream({ start: (c) => signal.addEventListener('abort', () => c.error(signal.reason)) });
  await assert.rejects(addModel('bge-small-en-v1.5', dir, () => {}, { fetch: fakeFetch(stalled), idleMs: 50 }), /received nothing for 0.05 s/);
  assert.deepEqual(readdirSync(dir), []);
});

test('a file that does not match its pinned hash is discarded with the rest', async () => {
  const dir = store();
  const small = () => new ReadableStream({ start: (c) => { c.enqueue(new TextEncoder().encode('not the model')); c.close(); } });
  await assert.rejects(addModel('bge-small-en-v1.5', dir, () => {}, { fetch: fakeFetch(small) }), /does not match its pinned SHA-256/);
  assert.deepEqual(readdirSync(dir), []);
});
