// Where moca-sign writes attestations, and how: names checked, nothing written outside attestations/, and no
// signature by one key replaced by a signature by another.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

/** A key id or reviewer as a file-name part: lower case letters, digits and hyphens. */
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/** A file name stem a user chose: letters, digits, `.`, `_` and `-`, starting with a letter or digit; no path. */
const STEM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Checks a file name stem a user chose, such as `review --name`. Returns it, or calls `fail` with the reason.
 * @param {string} stem
 * @param {(message: string) => Error} fail
 */
export function checkStem(stem, fail) {
  if (typeof stem !== 'string' || !STEM.test(stem) || stem.includes('..')) {
    throw fail(`"${stem}" is not a usable name: use up to 100 letters, digits, ".", "_" or "-", starting with a letter or digit`);
  }
  return stem;
}

/** The key ids that signed a DSSE envelope or a Sigstore bundle's envelope, as written in it. */
function keyidsIn(value) {
  const envelope = value?.dsseEnvelope ?? value;
  return Array.isArray(envelope?.signatures) ? envelope.signatures.map((s) => s?.keyid).filter((k) => typeof k === 'string') : [];
}

/**
 * Writes an attestation file under a package directory, through a temporary name. A DSSE file already there that
 * was signed with another key id is never replaced: two key ids can share a file name (`Acme` and `acme` both give
 * `package.acme.dsse.json`), and replacing it would drop the other signature.
 *
 * @param {string} dir  the package directory
 * @param {string} file  the path under it, starting attestations/
 * @param {object} value  the envelope or bundle
 * @param {{ keyid?: string, fail: (message: string) => Error }} p
 */
export function writeAttestation(dir, file, value, { keyid, fail }) {
  const path = join(dir, file);
  if (keyid !== undefined && existsSync(path)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      existing = undefined;
    }
    const others = keyidsIn(existing).filter((k) => k !== keyid);
    if (others.length > 0) {
      throw fail(`${file.split('\\').join('/')} already holds a signature by key ${others.join(', ')}; key ${keyid} would replace it. Use a key id that gives another file name`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.partial`);
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
