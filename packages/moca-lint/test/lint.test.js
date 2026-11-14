import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintPackage, packPackage, extractArchive } from '../lib/index.js';

const repo = process.env.MOCA_SPEC_DIR ?? fileURLToPath(new URL('../../../../moca-spec/', import.meta.url));
const bin = fileURLToPath(new URL('../bin/moca-lint.js', import.meta.url));
const trustRoot = join(repo, 'fixtures/signing-keys/trust-root.json');

test('the support-kb example lints clean with the example trust root', async () => {
  const r = await lintPackage({ target: join(repo, 'examples/support-kb'), trustRoot, sidecar: join(repo, 'examples/sidecars/support-kb.moca.idx') });
  assert.equal(r.ok, true);
  assert.deepEqual(r.diagnostics.filter((d) => d.severity !== 'info'), []);
});

test('pack writes an archive with the same digest, and refuses an invalid package', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'moca-lint-')), 'kb.moca');
  const packed = await packPackage({ dir: join(repo, 'examples/support-kb'), out, trustRoot });
  assert.equal(packed.written, true);
  const again = await lintPackage({ target: out, trustRoot });
  assert.equal(again.result.digest, packed.result.digest);
  assert.deepEqual(again.result.capabilities.sort(), packed.result.capabilities.sort());

  const bad = join(mkdtempSync(join(tmpdir(), 'moca-lint-')), 'bad.moca');
  const refused = await packPackage({ dir: join(repo, 'conformance/fixtures/type-missing'), out: bad });
  assert.equal(refused.written, false);
  assert.equal(existsSync(bad), false);

  const dest = mkdtempSync(join(tmpdir(), 'moca-extract-'));
  assert.ok(extractArchive({ archive: out, out: dest }) > 0);
  assert.equal((await lintPackage({ target: dest })).result.digest, packed.result.digest);
});

test('the CLI exits 1 on errors and 0 on a clean package', () => {
  const ok = spawnSync(process.execPath, [bin, 'lint', join(repo, 'examples/minimal')], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [bin, 'lint', join(repo, 'conformance/fixtures/type-missing'), '--format', 'json'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).diagnostics[0].code, 'C003_TYPE_MISSING');
});

test('digest prints the canonical digest', () => {
  const r = spawnSync(process.execPath, [bin, 'digest', join(repo, 'examples/minimal')], { encoding: 'utf8' });
  assert.match(r.stdout.trim(), /^sha256:[a-f0-9]{64}$/);
});

test('--strict promotes warnings to errors', async () => {
  const r = await lintPackage({ target: join(repo, 'conformance/fixtures/link-unresolved'), strict: true });
  assert.equal(r.ok, false);
});

test('warns when a page\'s primary concept is deprecated or replaced but the page is not retired (ADR-0020)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moca-lint-retired-'));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/retired', version: '1.0.0', title: 'R' }));
  writeFileSync(join(dir, 'structure.ttl'), [
    '@prefix skos: <http://www.w3.org/2004/02/skos/core#> .',
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix owl: <http://www.w3.org/2002/07/owl#> .',
    '@prefix x: <https://example.org/r#> .',
    'x:Old a skos:Concept ; owl:deprecated true .',
    'x:New a skos:Concept ; dct:replaces x:Old .',
    'x:Gone a skos:Concept ; owl:deprecated true .',
    '',
  ].join('\n'));
  const page = (concept, status = 'stable') => `---\ntype: Note\ntitle: P\nstatus: ${status}\nmoca:\n  concepts:\n    - { iri: "https://example.org/r#${concept}", role: primary }\n---\n\n# P\n`;
  writeFileSync(join(dir, 'content/old.md'), page('Old'));
  writeFileSync(join(dir, 'content/old-retired.md'), page('Old', 'deprecated'));
  writeFileSync(join(dir, 'content/new.md'), page('New'));
  writeFileSync(join(dir, 'content/gone.md'), page('Gone'));
  writeFileSync(join(dir, 'content/old-ended.md'), page('Old').replace('moca:\n', 'moca:\n  valid_until: 2026-01-01T00:00:00Z\n'));

  const r = await lintPackage({ target: dir });
  const warned = r.diagnostics.filter((d) => d.code === 'LINT_RETIRED_CONCEPT');
  assert.deepEqual(warned.map((d) => d.file).sort(), ['content/gone.md', 'content/old.md']);
  assert.match(warned.find((d) => d.file === 'content/old.md').message, /replaced.*use instead: https:\/\/example\.org\/r#New \(content\/new\.md\)/);
  assert.equal(r.ok, true);
});

test('acme-support marks its retired pages, so it has no retired-concept warnings', async () => {
  const r = await lintPackage({ target: join(repo, 'examples/acme-support') });
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'LINT_RETIRED_CONCEPT'), []);
});

test('pack warns when an encrypted-only package is packed plain, and refuses under --strict', async () => {
  const fixture = join(repo, 'conformance/fixtures/distribution-encrypted-only');
  const dir = mkdtempSync(join(tmpdir(), 'moca-lint-plain-'));
  const packed = await packPackage({ dir: fixture, out: join(dir, 'a.moca') });
  assert.equal(packed.written, true);
  assert.deepEqual(packed.diagnostics.map((d) => [d.code, d.severity]), [['LINT_DISTRIBUTION_PACKED_PLAIN', 'warning']]);
  const strict = await packPackage({ dir: fixture, out: join(dir, 'b.moca'), strict: true });
  assert.equal(strict.written, false);
  assert.equal(existsSync(join(dir, 'b.moca')), false);
  const open = await packPackage({ dir: join(repo, 'conformance/fixtures/valid-minimal'), out: join(dir, 'c.moca') });
  assert.deepEqual(open.diagnostics, []);
});
