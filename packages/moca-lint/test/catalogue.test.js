import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintPackage, imageSize } from '../lib/index.js';
import { loadVocabulary, vocabularyDiagnostics } from '../lib/vocabulary.js';

// moca-spec #7: authoring checks for images and translations, and the vocabulary check. Headers only, never decoded.
const NODE = '---\ntype: Note\ntitle: A\ntags: [returns]\n---\n\n# A\n\nText.\n';

/** A PNG header: signature and IHDR. */
function png(width, height) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

/** A JPEG header: SOI, an APP0 segment, then SOF0. */
function jpeg(width, height) {
  const app0 = Buffer.from('ffe000104a46494600010100000100010000', 'hex');
  const sof = Buffer.from('ffc0001108000000000301220002110103110100', 'hex');
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from('ffd8', 'hex'), app0, sof]);
}

/** WebP headers: VP8 (lossy), VP8L (lossless) and VP8X (extended). */
function webp(kind, width, height) {
  const head = (chunk, body) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.from(chunk), Buffer.alloc(4), body]);
  if (kind === 'VP8 ') {
    const body = Buffer.alloc(10);
    Buffer.from('9d012a', 'hex').copy(body, 3);
    body.writeUInt16LE(width, 6);
    body.writeUInt16LE(height, 8);
    return head(kind, body);
  }
  if (kind === 'VP8L') {
    const body = Buffer.alloc(10);
    body[0] = 0x2f;
    body.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
    return head(kind, body);
  }
  const body = Buffer.alloc(10);
  body.writeUIntLE(width - 1, 4, 3);
  body.writeUIntLE(height - 1, 7, 3);
  return head(kind, body);
}

function makePackage(manifest, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'moca-lint-catalogue-'));
  writeFileSync(join(dir, 'moca.json'), JSON.stringify({ id: 'https://example.com/t', version: '1.0.0', title: 'T', language: 'en', ...manifest }));
  for (const [path, data] of Object.entries({ 'content/a.md': NODE, ...files })) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), data);
  }
  return dir;
}
const lintCodes = async (manifest, files) => (await lintPackage({ target: makePackage(manifest, files) })).diagnostics.map((d) => d.code).sort();
const icon = (src, extra = {}) => ({ src, role: 'icon', type: 'image/png', alt: 'An icon', ...extra });
const cover = (src, type, extra = {}) => ({ src, role: 'cover', type, alt: 'A cover', ...extra });

test('the pixel size is read from each header', () => {
  assert.deepEqual(imageSize(png(256, 200), 'image/png'), { width: 256, height: 200 });
  assert.deepEqual(imageSize(jpeg(1920, 1080), 'image/jpeg'), { width: 1920, height: 1080 });
  assert.deepEqual(imageSize(webp('VP8 ', 960, 540), 'image/webp'), { width: 960, height: 540 });
  assert.deepEqual(imageSize(webp('VP8L', 1280, 720), 'image/webp'), { width: 1280, height: 720 });
  assert.deepEqual(imageSize(webp('VP8X', 3840, 2160), 'image/webp'), { width: 3840, height: 2160 });
  assert.equal(imageSize(Buffer.from('89504e47', 'hex'), 'image/png'), null);
});

test('a 16:9 cover and a square icon pass', async () => {
  assert.deepEqual(await lintCodes(
    { images: [icon('media/i.png', { sizes: '256x256' }), cover('media/c.jpg', 'image/jpeg', { sizes: '1920x1080' })] },
    { 'media/i.png': png(256, 256), 'media/c.jpg': jpeg(1920, 1080) },
  ), []);
});

test('an image with no alt text', async () => {
  assert.deepEqual(await lintCodes({ images: [{ src: 'media/i.png', role: 'icon', type: 'image/png' }] }, { 'media/i.png': png(256, 256) }), ['LINT_IMAGE_ALT_MISSING']);
});

test('a cover at 4:3, and one at 640x360', async () => {
  assert.deepEqual(await lintCodes({ images: [cover('media/c.webp', 'image/webp')] }, { 'media/c.webp': webp('VP8X', 1600, 1200) }), ['LINT_COVER_SHAPE']);
  assert.deepEqual(await lintCodes({ images: [cover('media/c.webp', 'image/webp')] }, { 'media/c.webp': webp('VP8L', 640, 360) }), ['LINT_IMAGE_TOO_SMALL']);
});

test('a cover within 1% of 16:9 passes', async () => {
  assert.deepEqual(await lintCodes({ images: [cover('media/c.png', 'image/png')] }, { 'media/c.png': png(1366, 768) }), []);
});

test('an icon at 128x128, and one at 256x200', async () => {
  assert.deepEqual(await lintCodes({ images: [icon('media/i.png')] }, { 'media/i.png': png(128, 128) }), ['LINT_IMAGE_TOO_SMALL']);
  assert.deepEqual(await lintCodes({ images: [icon('media/i.png')] }, { 'media/i.png': png(256, 200) }), ['LINT_ICON_NOT_SQUARE', 'LINT_IMAGE_TOO_SMALL']);
});

test('sizes that do not match the header', async () => {
  assert.deepEqual(await lintCodes({ images: [icon('media/i.png', { sizes: '512x512' })] }, { 'media/i.png': png(256, 256) }), ['LINT_IMAGE_SIZES_MISMATCH']);
});

test('a declared locale with no translation', async () => {
  assert.deepEqual(await lintCodes({ locales: ['fr', 'de'], translations: { fr: { title: 'T' } } }), ['LINT_TRANSLATION_MISSING']);
});

test('in strict mode the image warnings are errors', async () => {
  const r = await lintPackage({ target: makePackage({ images: [icon('media/i.png')] }, { 'media/i.png': png(128, 128) }), strict: true });
  assert.equal(r.ok, false);
});

const SCHEME = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix v: <https://vocab.example.com/> .
v:refunds a skos:Concept ; skos:prefLabel "Refunds"@en ; skos:altLabel "Remboursements"@fr .
v:returns a skos:Concept ; skos:prefLabel "Returns"@en .
v:support a skos:Concept ; skos:prefLabel "Customer support"@en .
`;
const STRUCTURE = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix p: <https://example.com/t/concepts/> .
p:refund-window a skos:Concept ; skos:prefLabel "Refund window"@en ; skos:exactMatch <https://vocab.example.com/refunds> .
p:warranty a skos:Concept ; skos:prefLabel "Warrenty"@en .
`;

test('the vocabulary check: prefLabel, altLabel in another language, IRI, exactMatch, and a miss with its nearest label', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moca-lint-vocab-'));
  writeFileSync(join(dir, 'scheme.ttl'), SCHEME.replace('v:support a skos:Concept ; skos:prefLabel "Customer support"@en .', 'v:support a skos:Concept ; skos:prefLabel "Customer support"@en .\nv:warranty a skos:Concept ; skos:prefLabel "Warranty"@en .'));
  const vocabulary = await loadVocabulary(join(dir, 'scheme.ttl'));
  const pkg = makePackage({
    locales: ['fr'],
    tags: ['refunds', 'https://vocab.example.com/support', 'shipping'],
    translations: { fr: { tags: ['remboursements'] } },
  }, { 'structure.ttl': STRUCTURE });
  const { result } = await lintPackage({ target: pkg });
  const found = vocabularyDiagnostics(result, vocabulary).map((d) => `${d.code} ${d.severity} ${d.message}`);
  const has = (re) => assert.ok(found.some((f) => re.test(f)), `${re} not in:\n${found.join('\n')}`);
  has(/^LINT_VOCABULARY_MATCH info tags "refunds" matches https:\/\/vocab\.example\.com\/refunds by the label "Refunds"@en/);
  has(/^LINT_VOCABULARY_MATCH info translations\.fr\.tags "remboursements" matches .*refunds by the label "Remboursements"@fr/);
  has(/^LINT_VOCABULARY_MATCH info tags "https:\/\/vocab\.example\.com\/support" matches .* by its IRI/);
  has(/^LINT_VOCABULARY_MATCH info tags "returns"/); // a page tag (OKF tags)
  has(/^LINT_VOCABULARY_UNMATCHED info tags "shipping" matches no concept/);
  has(/^LINT_VOCABULARY_MATCH info concept https:\/\/example\.com\/t\/concepts\/refund-window matches https:\/\/vocab\.example\.com\/refunds through skos:exactMatch/);
  has(/^LINT_VOCABULARY_UNMATCHED warning concept https:\/\/example\.com\/t\/concepts\/warranty .*nearest: "Warranty"@en/);
});

test('a tag in one language does not match a label in another', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moca-lint-vocab-'));
  writeFileSync(join(dir, 'scheme.ttl'), SCHEME);
  const vocabulary = await loadVocabulary(join(dir, 'scheme.ttl'));
  const { result } = await lintPackage({ target: makePackage({ tags: ['remboursements'] }) });
  const tag = vocabularyDiagnostics(result, vocabulary).find((d) => d.message.includes('"remboursements"'));
  assert.equal(tag.code, 'LINT_VOCABULARY_UNMATCHED');
});

test('a vocabulary with no skos:Concept is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moca-lint-vocab-'));
  writeFileSync(join(dir, 'empty.ttl'), '@prefix ex: <https://example.com/> .\nex:a ex:b ex:c .\n');
  await assert.rejects(loadVocabulary(join(dir, 'empty.ttl')), /declares no skos:Concept/);
});

test('the CLI takes a .moca package as the vocabulary', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { packPackage } = await import('../lib/index.js');
  const vocabDir = makePackage({}, { 'structure.ttl': SCHEME });
  const vocab = join(mkdtempSync(join(tmpdir(), 'moca-lint-vocab-')), 'vocab.moca');
  assert.equal((await packPackage({ dir: vocabDir, out: vocab })).written, true);
  const bin = fileURLToPath(new URL('../bin/moca-lint.js', import.meta.url));
  const out = spawnSync(process.execPath, [bin, 'lint', makePackage({ tags: ['Refunds'] }), '--vocabulary', vocab, '--format', 'json'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /LINT_VOCABULARY_MATCH/);
});

test('an open package that allows issued copies gets an info note; an encrypted-only one does not', async () => {
  const key = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAV7oSvpgKWeRJP+wg5aoP04bxrq2ZzOiT+NPhHsW1W4g=\n-----END PUBLIC KEY-----\n';
  const make = (distribution) => {
    const dir = mkdtempSync(join(tmpdir(), 'moca-lint-issued-'));
    writeFileSync(join(dir, 'moca.json'), JSON.stringify({
      id: 'https://example.com/t', version: '1.0.0', title: 'T',
      ...(distribution ? { distribution } : {}),
      issuedCopies: { issuers: [{ publicKey: key }], paths: ['content/'] },
    }));
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'content', 'a.md'), '---\ntype: Note\ntitle: A\n---\n\n# A\n\nText.\n');
    return dir;
  };
  const codes = async (dir) => (await lintPackage({ target: dir })).diagnostics.map((d) => d.code);
  assert.ok((await codes(make())).includes('LINT_ISSUED_COPIES_OPEN'));
  assert.ok((await codes(make('open'))).includes('LINT_ISSUED_COPIES_OPEN'));
  assert.ok(!(await codes(make('encrypted-only'))).includes('LINT_ISSUED_COPIES_OPEN'));
});
