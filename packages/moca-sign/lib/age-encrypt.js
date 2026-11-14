// age v1 encryption (https://c2sp.org/age) for envelopes (moca-spec encrypted packages §4): X25519 recipients or one
// passphrase. node:crypto only. The Readers are decrypt-only; this is the Producer side. Its output is checked by the
// Go reference age CLI in the tests.
import {
  createCipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync,
} from 'node:crypto';

const CHUNK = 64 * 1024;
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex');
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

export class EncryptError extends Error {}

function polymod(values) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk;
}

/** The 32-byte X25519 public key of an `age1…` recipient (Bech32), or an EncryptError. */
export function decodeRecipient(text) {
  const s = String(text).trim();
  if (s !== s.toLowerCase() && s !== s.toUpperCase()) throw new EncryptError(`not an age recipient: ${s}`);
  const lower = s.toLowerCase();
  const sep = lower.lastIndexOf('1');
  const hrp = lower.slice(0, sep);
  const data = [...lower.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  if (hrp !== 'age' || data.length < 6 || data.some((d) => d < 0) || polymod([...expanded, ...data]) !== 1) {
    throw new EncryptError(`not an X25519 age recipient (age1…): ${s}`);
  }
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  if (out.length !== 32) throw new EncryptError(`not an X25519 age recipient: ${s}`);
  return Buffer.from(out);
}

const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/, '');
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

function seal(key, nonce, plain) {
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function stanza(type, args, body) {
  const text = b64(body);
  const lines = [];
  for (let i = 0; i < text.length; i += 64) lines.push(text.slice(i, i + 64));
  // The last line is always shorter than 64 columns, so a body of a multiple of 48 bytes ends with an empty line.
  if (text.length % 64 === 0) lines.push('');
  return `-> ${[type, ...args].join(' ')}\n${lines.join('\n')}\n`;
}

/**
 * Encrypts bytes to age v1.
 * @param {Uint8Array} plain
 * @param {{ recipients?: string[], passphrase?: string, workFactor?: number }} to  recipients (`age1…`), or one
 *   passphrase. age allows a passphrase only as the single stanza of a file.
 * @returns {Buffer}
 */
export function ageEncrypt(plain, { recipients = [], passphrase, workFactor = 18 } = {}) {
  if ((recipients.length > 0) === (passphrase !== undefined)) throw new EncryptError('encrypt to recipients or to one passphrase, not both and not neither');
  const fileKey = randomBytes(16);
  const nonce12 = Buffer.alloc(12);
  let stanzas = '';
  if (passphrase !== undefined) {
    if (!Number.isInteger(workFactor) || workFactor < 1 || workFactor > 30) throw new EncryptError('the scrypt work factor must be a whole number from 1 to 30');
    const salt = randomBytes(16);
    const N = 2 ** workFactor;
    const key = scryptSync(Buffer.from(passphrase, 'utf8'), Buffer.concat([Buffer.from('age-encryption.org/v1/scrypt'), salt]), 32, { N, r: 8, p: 1, maxmem: 129 * 8 * N + 1024 * 1024 });
    stanzas += stanza('scrypt', [b64(salt), String(workFactor)], seal(key, nonce12, fileKey));
  }
  for (const r of recipients) {
    const recipient = decodeRecipient(r);
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    const share = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const shared = diffieHellman({ privateKey, publicKey: createPublicKey({ key: Buffer.concat([SPKI_X25519, recipient]), format: 'der', type: 'spki' }) });
    const wrapKey = hkdf(shared, Buffer.concat([share, recipient]), 'age-encryption.org/v1/X25519');
    stanzas += stanza('X25519', [b64(share)], seal(wrapKey, nonce12, fileKey));
  }
  const headerNoMac = Buffer.from(`age-encryption.org/v1\n${stanzas}---`);
  const mac = createHmac('sha256', hkdf(fileKey, Buffer.alloc(0), 'header')).update(headerNoMac).digest();
  const payloadNonce = randomBytes(16);
  const payloadKey = hkdf(fileKey, payloadNonce, 'payload');
  const parts = [headerNoMac, Buffer.from(` ${b64(mac)}\n`), payloadNonce];
  const data = Buffer.from(plain);
  let counter = 0;
  for (let pos = 0; ; pos += CHUNK, counter++) {
    const last = data.length - pos <= CHUNK;
    const n = Buffer.alloc(12);
    n.writeUIntBE(counter, 5, 6);
    n[11] = last ? 1 : 0;
    parts.push(seal(payloadKey, n, data.subarray(pos, last ? data.length : pos + CHUNK)));
    if (last) break;
  }
  return Buffer.concat(parts);
}
