// Runs the lint Worker in workerd, Cloudflare's runtime, through wrangler.
//
//   npm run test:workers -w @openmoca/moca-lint   (needs moca-spec beside this repo, or MOCA_SPEC_DIR)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { unstable_dev } from 'wrangler';
import { openSource } from '@openmoca/moca-core';

const here = fileURLToPath(new URL('.', import.meta.url));
const spec = process.env.MOCA_SPEC_DIR ?? join(here, '../../../../moca-spec');
let worker;

before(async () => {
  worker = await unstable_dev(join(here, 'worker.js'), { config: join(here, 'wrangler.toml'), experimental: { disableExperimentalWarning: true }, logLevel: 'warn' });
});
after(() => worker?.stop());

function archiveOf(dir) {
  const source = openSource(dir);
  const zip = new AdmZip();
  for (const e of source.list()) zip.addFile(e.path, source.read(e.path));
  return zip.toBuffer();
}

test('lints a posted archive in workerd', async () => {
  const response = await worker.fetch('/lint', { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: archiveOf(join(spec, 'examples/support-kb')) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.package.id, 'https://example.com/moca/support-kb');
});

test('reports a broken package in workerd', async () => {
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('no manifest'));
  const body = await (await worker.fetch('/lint', { method: 'POST', body: zip.toBuffer() })).json();
  assert.equal(body.ok, false);
  assert.ok(body.diagnostics.some((d) => d.code === 'T002_MANIFEST_NOT_FOUND'));
});
