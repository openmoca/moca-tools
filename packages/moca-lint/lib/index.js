// @openmoca/moca-lint: lint, pack and extract MOCA packages. All checking is
// done by the reference Reader in @openmoca/moca-core, so a lint result is
// exactly what a conformant Reader concludes about the package.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { readPackage, bindSidecar, directoryResolver, openSource, TargetError } from '@openmoca/moca-core';

export class UsageError extends Error {}

/**
 * @param {object} p
 * @param {string} p.target  directory or .moca archive
 * @param {string} [p.trustRoot]  trust-root file
 * @param {string[]} [p.memberDirs]  where to look for members
 * @param {string} [p.sidecar]  sidecar folder or .mocai archive to check against the package
 * @param {boolean} [p.strict]
 * @param {{ decryptor?: object, keyProvider?: Function }} [p.envelope]  opens an envelope (encrypted packages); the CLI
 *   passes the age decryptor and the user's key here, so this module never loads cryptography itself
 */
export async function lintPackage({ target, trustRoot, memberDirs, sidecar, strict = false, envelope = {} }) {
  const resolveMember = memberDirs?.length ? directoryResolver(memberDirs) : undefined;
  const result = await readPackage(target, { trustRoot, resolveMember, strict, ...envelope });
  const diagnostics = [...result.diagnostics, ...retiredConceptWarnings(result, strict), ...catalogueWarnings(result, strict), ...issuedCopyNotes(result)];
  if (sidecar && result.valid) {
    const bound = bindSidecar(sidecar, result, { strict });
    diagnostics.push(...bound.diagnostics);
  }
  return { result, diagnostics, ok: !diagnostics.some((d) => d.severity === 'error') };
}

/**
 * moca-spec ADR-0020: structure never hides content, so a page whose primary
 * concept is deprecated or replaced, but which is neither `status: deprecated`
 * nor bounded by its own `moca.valid_until`, is still retrieved. Warn the author at authoring time.
 * This is a lint check, not a Reader diagnostic.
 */
export function retiredConceptWarnings(result, strict = false) {
  const graph = result.structure?.graph;
  if (!graph) return [];
  const reps = result.nodes.flatMap((n) => n.representations);
  const boundTo = (iri) => reps.filter((r) => (r.frontmatter.moca?.concepts ?? []).some((c) => c?.iri === iri)).map((r) => r.file);
  const out = [];
  for (const rep of reps) {
    if (rep.frontmatter.status === 'deprecated' || rep.frontmatter.moca?.valid_until !== undefined) continue;
    for (const binding of Array.isArray(rep.frontmatter.moca?.concepts) ? rep.frontmatter.moca.concepts : []) {
      if (binding?.role !== 'primary' || typeof binding.iri !== 'string') continue;
      const concept = graph.concepts.get(binding.iri);
      const replacedBy = graph.in('replaces', binding.iri).map((e) => e.iri);
      if (!concept?.declared || (!concept.deprecated && replacedBy.length === 0)) continue;
      const how = replacedBy.length > 0 ? 'replaced' : 'deprecated';
      const instead = replacedBy.map((iri) => {
        const files = boundTo(iri);
        return files.length > 0 ? `${iri} (${files.join(', ')})` : iri;
      });
      out.push({
        code: 'LINT_RETIRED_CONCEPT',
        severity: strict ? 'error' : 'warning',
        message: `primary concept ${binding.iri} is ${how}, but this page is neither status: deprecated nor bounded by valid_until, so it is still retrieved${instead.length > 0 ? `; use instead: ${instead.join('; ')}` : ''}`,
        file: rep.file,
      });
    }
  }
  return out;
}

/**
 * The pixel size from an image's header only (PNG IHDR, the JPEG start-of-frame marker, the WebP VP8, VP8L or VP8X
 * header). Nothing is decoded. Null when the header cannot be read.
 * @param {Uint8Array} b
 * @param {string} type
 * @returns {{ width: number, height: number } | null}
 */
export function imageSize(b, type) {
  const u16 = (i) => (b[i] << 8) | b[i + 1];
  const u32 = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const le24 = (i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const ok = (width, height) => (width > 0 && height > 0 ? { width, height } : null);
  if (type === 'image/png') return b.length >= 24 && String.fromCharCode(...b.subarray(12, 16)) === 'IHDR' ? ok(u32(16), u32(20)) : null;
  if (type === 'image/jpeg') {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return ok(u16(i + 7), u16(i + 5));
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (type === 'image/webp' && b.length >= 30) {
    const chunk = String.fromCharCode(...b.subarray(12, 16));
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return ok(((b[27] << 8) | b[26]) & 0x3fff, ((b[29] << 8) | b[28]) & 0x3fff);
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (chunk === 'VP8X') return ok(le24(24) + 1, le24(27) + 1);
  }
  return null;
}

/**
 * moca-spec package spec §4.11: a package that allows issued copies but is `open`. Issued copies usually go with
 * paid or licensed use, and an open package can be passed on unmarked, so the publisher may have meant
 * `encrypted-only`. A note only: the two are independent.
 */
export function issuedCopyNotes(result) {
  if (!result.valid || !result.manifest?.issuedCopies || (result.distribution ?? 'open') !== 'open') return [];
  return [{
    code: 'LINT_ISSUED_COPIES_OPEN',
    severity: 'info',
    message: 'issuedCopies allows issued copies, but distribution is open, so the package can also be passed on unmarked; check that this is what you meant',
    file: 'moca.json',
  }];
}

/**
 * moca-spec package spec §4.6–4.7 and #7: authoring checks for images and translations. A Reader never decodes an
 * image; this tool reads pixel sizes from the file header only. Lint checks, not Reader diagnostics.
 */
export function catalogueWarnings(result, strict = false) {
  if (!result.valid || !result.manifest) return [];
  const warning = strict ? 'error' : 'warning';
  const file = 'moca.json';
  const out = [];
  for (const image of result.images ?? []) {
    if (image.alt === undefined) out.push({ code: 'LINT_IMAGE_ALT_MISSING', severity: warning, message: `${image.src} has no alt text for people who cannot see it`, file });
    const size = imageSize(result.source.read(image.src), image.type);
    if (!size) continue;
    const { width, height } = size;
    const actual = `${width}x${height}`;
    if (image.sizes !== undefined && !image.sizes.split(' ').includes(actual)) {
      out.push({ code: 'LINT_IMAGE_SIZES_MISMATCH', severity: warning, message: `${image.src} is ${actual}, and sizes says "${image.sizes}"`, file });
    }
    if (image.role === 'icon') {
      if (width !== height) out.push({ code: 'LINT_ICON_NOT_SQUARE', severity: warning, message: `the icon ${image.src} is ${actual}, not square`, file });
      if (width < 256 || height < 256) out.push({ code: 'LINT_IMAGE_TOO_SMALL', severity: warning, message: `the icon ${image.src} is ${actual}, under 256x256`, file });
    } else if (image.role === 'cover') {
      if (Math.abs(width / height - 16 / 9) > 0.01 * (16 / 9)) out.push({ code: 'LINT_COVER_SHAPE', severity: warning, message: `the cover ${image.src} is ${actual}, not 16:9`, file });
      if (width < 960 || height < 540) out.push({ code: 'LINT_IMAGE_TOO_SMALL', severity: warning, message: `the cover ${image.src} is ${actual}, under 960x540`, file });
    }
  }
  const translated = new Set(Object.keys(result.translations ?? {}).map((t) => t.toLowerCase()));
  for (const locale of Array.isArray(result.manifest.locales) ? result.manifest.locales : []) {
    if (!translated.has(locale.toLowerCase())) {
      out.push({ code: 'LINT_TRANSLATION_MISSING', severity: 'info', message: `locale ${locale} has no translation of the manifest's title and description`, file });
    }
  }
  return out;
}

/**
 * Lints, then writes a .moca archive of the package's regular files. Refuses
 * to write anything when lint reports an error.
 */
export async function packPackage({ dir, out, trustRoot, memberDirs, strict = false }) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError(`not a package directory: ${dir}`);
  const lint = await lintPackage({ target: dir, trustRoot, memberDirs, strict });
  const plain = plainPackWarnings(lint.result, strict);
  lint.diagnostics.push(...plain);
  if (plain.some((d) => d.severity === 'error')) lint.ok = false;
  if (!lint.ok) return { written: false, ...lint };
  const source = lint.result.source;
  const zip = new AdmZip();
  for (const entry of source.list()) {
    // Regular files only; hidden entries are never listed by a source.
    zip.addFile(entry.path, source.read(entry.path));
  }
  mkdirSync(dirname(out) || '.', { recursive: true });
  zip.writeZip(out);
  return { written: true, ...lint };
}

/**
 * moca-spec package spec §4.1: an `encrypted-only` package is meant to be handed
 * out only inside an envelope. Packing it as a plain .moca is allowed (the
 * envelope wraps a .moca), but the author is warned. A lint check, not a Reader
 * diagnostic.
 */
export function plainPackWarnings(result, strict = false) {
  if (result.distribution !== 'encrypted-only') return [];
  return [{
    code: 'LINT_DISTRIBUTION_PACKED_PLAIN',
    severity: strict ? 'error' : 'warning',
    message: 'distribution is encrypted-only, but this writes a plain .moca; encrypt it before handing it out',
    file: 'moca.json',
  }];
}

/** Safely extracts a .moca archive: the same checks a Reader applies. */
export function extractArchive({ archive, out }) {
  let source;
  try {
    source = openSource(archive);
  } catch (err) {
    if (err instanceof TargetError) throw new UsageError(err.message);
    throw err;
  }
  if (source.kind !== 'archive') throw new UsageError(`not a .moca/.zip archive: ${archive}`);
  const entries = source.list();
  const unsafe = entries.find((e) => e.kind !== 'file');
  if (unsafe) throw new UsageError(`archive entry "${unsafe.path}" is not a regular file; refusing to extract`);
  for (const e of entries) {
    const dest = join(out, ...e.path.split('/'));
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, source.read(e.path));
  }
  return entries.length;
}
