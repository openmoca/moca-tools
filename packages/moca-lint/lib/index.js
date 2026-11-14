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
 * @param {string} [p.sidecar]  sidecar directory or .zip to check against the package
 * @param {boolean} [p.strict]
 */
export async function lintPackage({ target, trustRoot, memberDirs, sidecar, strict = false }) {
  const resolveMember = memberDirs?.length ? directoryResolver(memberDirs) : undefined;
  const result = await readPackage(target, { trustRoot, resolveMember, strict });
  const diagnostics = [...result.diagnostics, ...retiredConceptWarnings(result, strict)];
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
