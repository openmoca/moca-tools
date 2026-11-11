// Trust roots (spec/moca-attestations.md section 6): the reader's list of whose signatures it accepts, and for what.
// These functions edit the document in memory; the caller reads and writes the file.
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isPrimeOrderPoint, validateAgainst } from './deps.js';

export const ROLES = Object.freeze(['package', 'review']);

export class TrustRootError extends Error {}

/** Reads a trust root, or returns an empty one when the file does not exist yet. */
export function readTrustRoot(path) {
  if (!existsSync(path)) return {};
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new TrustRootError(`${path} is not JSON: ${err.message}`);
  }
  check(doc, path);
  return doc;
}

/** Checks the document against trust-root.schema.json, then writes it. */
export function writeTrustRoot(path, doc) {
  check(doc, path);
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
}

function check(doc, path) {
  const errors = validateAgainst('trustRoot', doc);
  if (errors.length > 0) throw new TrustRootError(`${path} is not a valid trust root: ${errors.join('; ')}`);
}

/**
 * Splits "package,review" into roles, refusing any other value. Undefined means both:
 * a trust root always lists roles (attestations §6).
 */
export function parseRoles(text) {
  if (text === undefined) return [...ROLES];
  const roles = [...new Set(text.split(',').map((r) => r.trim()).filter(Boolean))];
  const unknown = roles.filter((r) => !ROLES.includes(r));
  if (roles.length === 0 || unknown.length > 0) {
    throw new TrustRootError(`roles must be package, review or both, comma-separated; got "${text}"`);
  }
  return roles;
}

/** Normalises an expiry date to an ISO 8601 date-time, refusing anything Date cannot read. */
export function parseExpires(text) {
  if (text === undefined) return undefined;
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00Z` : text);
  if (Number.isNaN(time)) throw new TrustRootError(`--expires must be a date, such as 2027-01-01; got "${text}"`);
  return new Date(time).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * Checks a PEM public key. DSSE keys are Ed25519 (attestations §5): a trusted key of any other type would verify
 * nothing, so it is refused here rather than written into a trust root that cannot use it.
 * @returns {{ pem: string, type: string }}
 */
export function checkPublicKey(pem) {
  // Node would derive the public half of a private key; refuse instead, as a private key does not belong here.
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    throw new TrustRootError('that is a private key: pass the public key (.pub.pem) instead, and keep the private key secret');
  }
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new TrustRootError('the public key is not a PEM public key (expected "-----BEGIN PUBLIC KEY-----")');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TrustRootError(`that is an ${key.asymmetricKeyType.toUpperCase()} key; MOCA DSSE keys are Ed25519 (attestations §5), so it would verify nothing`);
  }
  // Attestations §5: a key that is not a point of prime order (a small-order or mixed-order point) verifies nothing.
  if (!isPrimeOrderPoint(Buffer.from(key.export({ format: 'jwk' }).x, 'base64url'))) {
    throw new TrustRootError('that Ed25519 key is a small-order or mixed-order point, so it would verify nothing (attestations §5)');
  }
  return { pem: key.export({ type: 'spki', format: 'pem' }), type: key.asymmetricKeyType };
}

/**
 * Adds a key, or replaces the one with the same keyid.
 * @returns {{ doc: object, replaced: boolean }}
 */
export function addKey(doc, { keyid, publicKey, identity, roles, expires }) {
  if (!keyid) throw new TrustRootError('a key needs a key id');
  const entry = {
    keyid,
    publicKey,
    identity: identity ?? keyid,
    ...(expires ? { expires } : {}),
    roles: roles ?? [...ROLES],
  };
  const keys = doc.keys ?? [];
  const replaced = keys.some((k) => k.keyid === keyid);
  return { doc: { ...doc, keys: [...keys.filter((k) => k.keyid !== keyid), entry] }, replaced };
}

/**
 * Adds a Sigstore identity, or replaces the one with the same issuer and subject.
 * @returns {{ doc: object, replaced: boolean }}
 */
export function addSigstoreIdentity(doc, { issuer, subject, roles }) {
  if (!issuer || !subject) throw new TrustRootError('a Sigstore identity needs an issuer and a subject');
  if (!/^https:\/\//.test(issuer)) throw new TrustRootError(`the issuer is the OIDC issuer's https:// address; got "${issuer}"`);
  const same = (i) => i.issuer === issuer && i.subject === subject;
  const identities = doc.sigstore?.identities ?? [];
  const replaced = identities.some(same);
  const entry = { issuer, subject, roles: roles ?? [...ROLES] };
  return { doc: { ...doc, sigstore: { ...doc.sigstore, identities: [...identities.filter((i) => !same(i)), entry] } }, replaced };
}

/**
 * Removes a key by keyid, or a Sigstore identity by issuer and subject.
 * @returns {{ doc: object, removed: boolean }}
 */
export function removeEntry(doc, { keyid, issuer, subject }) {
  if (keyid) {
    const keys = doc.keys ?? [];
    const removed = keys.some((k) => k.keyid === keyid);
    return { doc: { ...doc, keys: keys.filter((k) => k.keyid !== keyid) }, removed };
  }
  if (!issuer || !subject) throw new TrustRootError('name a key with --keyid, or a Sigstore identity with --issuer and --subject');
  const identities = doc.sigstore?.identities ?? [];
  const keep = identities.filter((i) => !(i.issuer === issuer && i.subject === subject));
  return { doc: { ...doc, sigstore: { ...doc.sigstore, identities: keep } }, removed: keep.length < identities.length };
}

/**
 * One line per entry, for people to read.
 * @returns {string[]}
 */
export function describeTrustRoot(doc, now = new Date()) {
  const roles = (r) => (r ? r.join(',') : 'package,review');
  const rows = [
    ...(doc.keys ?? []).map((k) => {
      let state = '';
      if (k.expires) state = Date.parse(k.expires) < now.getTime() ? `, EXPIRED ${k.expires}` : `, expires ${k.expires}`;
      return ['key', roles(k.roles), `${k.keyid} (${k.identity ?? k.keyid}${state})`];
    }),
    ...(doc.sigstore?.identities ?? []).map((i) => ['sigstore', roles(i.roles), `${i.subject} (issuer ${i.issuer})`]),
  ];
  const widths = [0, 1].map((c) => Math.max(0, ...rows.map((r) => r[c].length)));
  return rows.map(([kind, role, who]) => `${kind.padEnd(widths[0])}  ${role.padEnd(widths[1])}  ${who}`);
}
