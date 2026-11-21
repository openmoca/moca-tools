// @openmoca/moca-sign: writes package and review attestations
// (spec/moca-attestations.md) and verifies them through @openmoca/moca-core.
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { slug, checkStem, writeAttestation } from './files.js';
import { ROLES } from './trust.js';
import {
  readPackage, createEnvelope, packageStatement, reviewStatement, PAYLOAD_TYPE, CONTENT_DIR_PREFIX,
} from './deps.js';

export class SignError extends Error {}

export {
  readTrustRoot, writeTrustRoot, checkTrustRoot, addKey, addSigstoreIdentity, removeEntry, describeTrustRoot, checkPublicKey,
  parseRoles, parseIds, parseExpires, TrustRootError, ROLES, ALL_ROLES,
} from './trust.js';
export { issueCopy, compareCopy, IssueError } from './issue.js';

/** @returns {{ privateKeyPem: string, publicKeyPem: string }} */
export function generateKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

/** A trust-root document listing one key. */
export function trustRootFor({ keyid, publicKeyPem, identity, roles }) {
  return { keys: [{ keyid, publicKey: publicKeyPem, identity: identity ?? keyid, roles: roles ?? [...ROLES] }] };
}

async function readValid(dir) {
  const pkg = await readPackage(dir);
  if (!pkg.valid || !pkg.digest) {
    const errors = pkg.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`);
    throw new SignError(`refusing to attest an invalid package:\n  ${errors.join('\n  ')}`);
  }
  return pkg;
}

function statementBytes(statement) {
  return Buffer.from(JSON.stringify(statement), 'utf8');
}

async function sigstoreBundle(statement, signOptions) {
  const { attest } = await import('sigstore');
  return attest(statementBytes(statement), PAYLOAD_TYPE, signOptions);
}

/**
 * Writes attestations/package.<keyid>.dsse.json (or package.sigstore.json).
 *
 * @param {object} p
 * @param {string} p.dir  package directory
 * @param {string} [p.privateKeyPem]
 * @param {string} [p.keyid]
 * @param {boolean} [p.sigstore]
 * @param {object} [p.signOptions]  passed to sigstore's attest()
 */
export async function signPackage({ dir, privateKeyPem, keyid, sigstore = false, signOptions = {} }) {
  const pkg = await readValid(dir);
  const statement = packageStatement({ id: pkg.manifest.id, version: pkg.manifest.version, digest: pkg.digest });
  let file;
  let value;
  if (sigstore) {
    file = join('attestations', 'package.sigstore.json');
    value = await sigstoreBundle(statement, signOptions);
  } else {
    if (!privateKeyPem || !keyid) throw new SignError('dsse signing needs a private key and a key id');
    file = join('attestations', `package.${slug(keyid)}.dsse.json`);
    value = createEnvelope({ payload: statementBytes(statement), payloadType: PAYLOAD_TYPE, privateKeyPem, keyid });
  }
  writeAttestation(dir, file, value, { keyid: sigstore ? undefined : keyid, fail: (m) => new SignError(m) });
  return { file: file.split('\\').join('/'), digest: pkg.digest };
}

/**
 * Writes a review attestation under attestations/reviews/.
 *
 * @param {object} p
 * @param {string} p.dir
 * @param {string[]} p.nodes  node paths (relative to content/) or package-relative paths
 * @param {string} p.reviewer  OKF actor, e.g. human:jane.doe
 * @param {'accurate'|'needs-change'|'inaccurate'} p.outcome
 * @param {string} [p.reviewedAt]  ISO 8601; defaults to now
 * @param {string} [p.scope]
 * @param {string} [p.note]
 * @param {string} [p.name]  file name stem: letters, digits, `.`, `_`, `-`; defaults to reviewer and date
 * @param {string} [p.privateKeyPem]
 * @param {string} [p.keyid]
 * @param {boolean} [p.sigstore]
 * @param {object} [p.signOptions]
 */
export async function reviewNodes({
  dir, nodes, reviewer, outcome, reviewedAt, scope, note, name, privateKeyPem, keyid, sigstore = false, signOptions = {},
}) {
  if (!nodes?.length) throw new SignError('name at least one node to review');
  if (name !== undefined) checkStem(name, (m) => new SignError(`--name: ${m}`));
  const pkg = await readValid(dir);
  const files = nodes.map((n) => {
    const path = (n.startsWith(CONTENT_DIR_PREFIX) ? n : `${CONTENT_DIR_PREFIX}${n}`).normalize('NFC');
    const sha256 = pkg.fileDigests.get(path);
    if (!sha256) throw new SignError(`${path} is not a file in the package`);
    return { path, sha256 };
  });
  const at = reviewedAt ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const statement = reviewStatement({ packageId: pkg.manifest.id, files, reviewer, reviewedAt: at, outcome, scope, note });
  const stem = name ?? `${slug(reviewer)}-${at.slice(0, 10)}`;
  let file;
  let value;
  if (sigstore) {
    file = join('attestations', 'reviews', `${stem}.sigstore.json`);
    value = await sigstoreBundle(statement, signOptions);
  } else {
    if (!privateKeyPem || !keyid) throw new SignError('dsse signing needs a private key and a key id');
    file = join('attestations', 'reviews', `${stem}.dsse.json`);
    value = createEnvelope({ payload: statementBytes(statement), payloadType: PAYLOAD_TYPE, privateKeyPem, keyid });
  }
  writeAttestation(dir, file, value, { keyid: sigstore ? undefined : keyid, fail: (m) => new SignError(m) });
  return { file: file.split('\\').join('/'), files };
}

/**
 * Verifies every attestation in a package against a trust root.
 * @returns {Promise<{ ok: boolean, attestations: object[], diagnostics: object[], digest: string|null }>}
 */
export async function verifyPackage({ dir, trustRoot, online = false, allowOfflineFallback = false, tufCachePath }) {
  const pkg = await readPackage(dir, { trustRoot, online, allowOfflineFallback, tufCachePath });
  const attestations = pkg.attestations;
  const ok = pkg.valid && attestations.length > 0 && attestations.every((a) => a.outcome === 'valid' || a.outcome === 'ignored')
    && pkg.signers.length > 0;
  return { ok, attestations, diagnostics: pkg.diagnostics, digest: pkg.digest, signers: pkg.signers };
}
export { ageEncrypt, decodeRecipient, checkWorkFactor, MIN_WORK_FACTOR, MAX_WORK_FACTOR, EncryptError } from './age-encrypt.js';
export { checkStem } from './files.js';
export {
  encryptPackage, decryptEnvelope, readIdentities, readRecipients, passphraseFromEnv, parseOutlineFields, OUTLINE_FIELDS, DEFAULT_OUTLINE,
} from './envelope.js';
