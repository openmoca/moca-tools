// moca-sign issue: binds a marked copy to its publisher's package (moca-spec attestations §3a).
// It compares the copy with the original and signs; it never marks anything.
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPackage, createEnvelope, issuedCopyStatement, rebuiltDigest, PAYLOAD_TYPE } from './deps.js';

export class IssueError extends Error {}

const PROFILE_ONTOLOGY = 'https://w3id.org/moca/profiles/ontology/v1';
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

async function readValid(dir, what) {
  const pkg = await readPackage(dir);
  if (!pkg.valid || !pkg.digest) {
    const errors = pkg.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
    throw new IssueError(`the ${what} is not a valid package:\n  ${errors.join('\n  ')}`);
  }
  return pkg;
}

/**
 * The changed files of a marked copy, checked against the rules an issued copy must follow (attestations §3a) and
 * the publisher's consent (package spec §4.11). Throws IssueError with every problem found.
 * @returns {{ original: object, copy: object, changed: Map<string, string> }}
 */
export async function compareCopy({ original: originalDir, copy: copyDir }) {
  const original = await readValid(originalDir, 'original');
  const copy = await readValid(copyDir, 'copy');
  const problems = [];
  if (copy.manifest.id !== original.manifest.id || copy.manifest.version !== original.manifest.version) {
    problems.push(`the copy is ${copy.manifest.id}@${copy.manifest.version}, the original ${original.manifest.id}@${original.manifest.version}`);
  }
  const consent = original.manifest.issuedCopies;
  if (!consent) problems.push("the original's moca.json has no issuedCopies, so the publisher allows no issued copies");
  const added = [...copy.fileDigests.keys()].filter((p) => !original.fileDigests.has(p));
  const removed = [...original.fileDigests.keys()].filter((p) => !copy.fileDigests.has(p));
  for (const p of added) problems.push(`${p} is in the copy but not the original: an issued copy adds no file`);
  for (const p of removed) problems.push(`${p} is in the original but not the copy: an issued copy removes no file`);
  const defined = new Set((original.manifest.profiles?.[PROFILE_ONTOLOGY]?.files ?? []).map((f) => f?.path));
  const changed = new Map();
  for (const [path, hash] of copy.fileDigests) {
    const before = original.fileDigests.get(path);
    if (before === undefined || before === hash) continue;
    changed.set(path, before);
    if (!/^(content|media)\//.test(path)) problems.push(`${path} changed: only files under content/ or media/ may change`);
    else if (path.split('/').some((s) => s.startsWith('.'))) problems.push(`${path} changed: a hidden entry may not change`);
    else if (defined.has(path)) problems.push(`${path} changed: a file a profile defines may not change`);
    else if (consent && !consent.paths.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p))) {
      problems.push(`${path} changed, but issuedCopies.paths does not allow it`);
    }
  }
  if (changed.size === 0) problems.push('the copy has the same bytes as the original: nothing to issue');
  if (problems.length > 0) throw new IssueError(`cannot issue this copy:\n  ${problems.join('\n  ')}`);
  return { original, copy, changed };
}

/**
 * Writes attestations/issued.<keyid>.dsse.json into the copy. The publisher's attestations are copied from the
 * original when the copy lacks them, so the copy verifies as the publisher's.
 * @returns {Promise<{ file: string, originalDigest: string, digest: string, changedFiles: string[], copied: string[] }>}
 */
export async function issueCopy({ original: originalDir, copy: copyDir, privateKeyPem, keyid }) {
  if (!privateKeyPem || !keyid) throw new IssueError('issuing needs a private key and a key id (issuers sign with a DSSE key, attestations §8)');
  const { original, copy, changed } = await compareCopy({ original: originalDir, copy: copyDir });
  // By construction the rebuilt digest is the original's; check it all the same.
  const originalDigest = rebuiltDigest(copy.fileDigests, changed);
  if (originalDigest !== original.digest) throw new IssueError('the rebuilt digest does not equal the original digest');
  const copied = [];
  const from = join(originalDir, 'attestations');
  if (existsSync(from)) {
    for (const entry of readdirSync(from, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const rel = join(entry.parentPath ?? entry.path, entry.name).slice(from.length + 1);
      if (rel.startsWith('issued.')) continue;
      const to = join(copyDir, 'attestations', rel);
      if (existsSync(to)) continue;
      mkdirSync(join(to, '..'), { recursive: true });
      cpSync(join(from, rel), to);
      copied.push(`attestations/${rel.split('\\').join('/')}`);
    }
  }
  const statement = issuedCopyStatement({
    id: copy.manifest.id, version: copy.manifest.version, digest: copy.digest, originalDigest, changedFiles: Object.fromEntries(changed),
  });
  const envelope = createEnvelope({ payload: Buffer.from(JSON.stringify(statement), 'utf8'), payloadType: PAYLOAD_TYPE, privateKeyPem, keyid });
  const file = `attestations/issued.${slug(keyid)}.dsse.json`;
  mkdirSync(join(copyDir, 'attestations'), { recursive: true });
  writeFileSync(join(copyDir, file), `${JSON.stringify(envelope, null, 2)}\n`);
  return { file, originalDigest, digest: copy.digest, changedFiles: [...changed.keys()].sort(), copied };
}
