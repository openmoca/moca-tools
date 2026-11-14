// moca-sign encrypt and decrypt: envelopes (moca-spec encrypted packages). The Producer side: it reads plain
// packages and writes envelopes, and decrypt writes plaintext to disk on purpose (the no-files rule of encrypted
// packages §5.4 binds Readers, not this tool).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import AdmZip from 'adm-zip';
import { readPackage, formatText } from '@openmoca/moca-core';
import { ageDecryptor } from '@openmoca/moca-core/age';
import { ageEncrypt, EncryptError } from './age-encrypt.js';

/** Manifest properties an outline may carry (encrypted packages §3). */
export const OUTLINE_FIELDS = Object.freeze(['id', 'version', 'title', 'description', 'language', 'license', 'publisher', 'mocaVersion', 'distribution']);
/** What tools write when the publisher does not choose (encrypted packages §3). */
export const DEFAULT_OUTLINE = Object.freeze(['id', 'version', 'title']);
const FIXED_TIME = new Date(Date.UTC(1980, 0, 1));

/** The .moca bytes of a package: an archive as it is, or a directory packed as moca-lint pack does. */
function packageBytes(target, result) {
  if (statSync(target).isFile()) return readFileSync(target);
  const zip = new AdmZip();
  for (const entry of result.source.list()) {
    zip.addFile(entry.path, result.source.read(entry.path));
    zip.getEntry(entry.path).header.time = FIXED_TIME;
  }
  return zip.toBuffer();
}

/** Checks the outline field list a user chose. `[]` writes no outline. */
export function parseOutlineFields(list) {
  const fields = [...new Set(list)];
  const unknown = fields.filter((f) => !OUTLINE_FIELDS.includes(f));
  if (unknown.length > 0) throw new EncryptError(`not an outline field: ${unknown.join(', ')} (allowed: ${OUTLINE_FIELDS.join(', ')})`);
  return fields;
}

/**
 * Writes an envelope for a valid package.
 * @param {{ pkg: string, out: string, recipients?: string[], passphrase?: string, workFactor?: number,
 *   outline?: string[], structure?: boolean, force?: boolean }} p  `outline` lists manifest fields to leave readable
 *   (default id, version, title; `[]` for none); `structure` adds the opt-in plain copy of structure.ttl.
 * @returns {Promise<{ out: string, digest: string, outline: object|undefined, warnings: string[] }>}
 */
export async function encryptPackage({ pkg, out, recipients = [], passphrase, workFactor, outline = DEFAULT_OUTLINE, structure = false, force = false }) {
  if (!existsSync(pkg)) throw new EncryptError(`${pkg} does not exist`);
  if (existsSync(out) && !force) throw new EncryptError(`${out} already exists; pass --force to replace it`);
  const result = await readPackage(pkg);
  if (result.envelope) throw new EncryptError(`${pkg} is already an envelope`);
  if (!result.valid) {
    throw new EncryptError(`the package is not valid:\n${formatText(result.diagnostics.filter((d) => d.severity === 'error'))}`);
  }
  const warnings = [];
  const fields = parseOutlineFields(outline);
  const chosen = Object.fromEntries(fields.filter((f) => Object.hasOwn(result.manifest, f)).map((f) => [f, result.manifest[f]]));
  const marker = { format: 'moca-enc-v1', ...(fields.length > 0 ? { outline: chosen } : {}) };

  const envelope = new AdmZip();
  const add = (name, bytes, stored) => {
    envelope.addFile(name, bytes);
    const entry = envelope.getEntry(name);
    entry.header.time = FIXED_TIME;
    if (stored) entry.header.method = 0;
  };
  add('moca-enc.json', Buffer.from(`${JSON.stringify(marker, null, 2)}\n`), false);
  add('package.age', ageEncrypt(packageBytes(pkg, result), { recipients, passphrase, workFactor }), true);
  if (structure) {
    const ttl = result.source.list().find((e) => e.path === 'structure.ttl');
    if (!ttl) throw new EncryptError('--structure: the package has no structure.ttl');
    add('outline/structure.ttl', result.source.read(ttl.path), false);
    warnings.push('outline/structure.ttl is readable without a key: it reveals the package\'s concept graph');
  }
  writeFileSync(out, envelope.toBuffer());

  // Check what was written the way a Reader will read it: without a key, only E001 (the entries and marker pass);
  // with the passphrase, it opens to the same digest.
  const shape = await readPackage(out);
  if (shape.diagnostics.map((d) => d.code).join() !== 'E001_ENCRYPTED_NO_KEY') throw new EncryptError(`the envelope failed its own check:\n${formatText(shape.diagnostics)}`);
  if (passphrase !== undefined) {
    const check = await readPackage(out, { decryptor: ageDecryptor, keyProvider: () => ({ passphrase }), limits: { maxScryptWorkFactor: Math.max(20, workFactor ?? 18) } });
    if (!check.envelope?.opened || check.digest !== result.digest) throw new EncryptError(`the envelope failed its own check:\n${formatText(check.diagnostics)}`);
  }
  return { out, digest: result.digest, outline: marker.outline, warnings };
}

/**
 * Opens an envelope as a Reader does (every check, including the outline), then writes the inner .moca archive.
 * @param {{ envelope: string, out: string, identities?: string[], passphrase?: string, force?: boolean, maxScryptWorkFactor?: number }} p
 */
export async function decryptEnvelope({ envelope, out, identities, passphrase, force = false, maxScryptWorkFactor = 20 }) {
  if (existsSync(out) && !force) throw new EncryptError(`${out} already exists; pass --force to replace it`);
  const key = identities?.length ? { identities } : passphrase !== undefined ? { passphrase } : null;
  if (!key) throw new EncryptError('pass an identity file or a passphrase');
  const options = { decryptor: ageDecryptor, keyProvider: () => key, limits: { maxScryptWorkFactor } };
  const result = await readPackage(envelope, options);
  if (!result.envelope) throw new EncryptError(`${envelope} is not an envelope`);
  if (!result.envelope.opened) throw new EncryptError(`the envelope did not open:\n${formatText(result.diagnostics)}`);
  const bytes = new Uint8Array(new AdmZip(envelope).getEntry('package.age').getData());
  const header = ageDecryptor.parseHeader(bytes, { maxScryptWorkFactor });
  writeFileSync(out, ageDecryptor.decrypt(bytes, header, key));
  return { out, digest: result.digest, valid: result.valid };
}

/** Reads `AGE-SECRET-KEY-1…` lines from identity files. */
export function readIdentities(files) {
  const identities = files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('AGE-SECRET-KEY-1')));
  if (identities.length === 0) throw new EncryptError(`no AGE-SECRET-KEY-1 identity in ${files.join(', ')}`);
  return identities;
}

/** Reads `age1…` recipients from recipient files (one per line; # comments and blank lines ignored). */
export function readRecipients(files) {
  return files.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
}

/** A passphrase from an environment variable, never from the command line. */
export function passphraseFromEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new EncryptError(`the environment variable ${name} is not set`);
  return value;
}
