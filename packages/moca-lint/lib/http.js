// moca-lint over HTTP, as a web-standard fetch handler: (Request) => Promise<Response>.
// It runs wherever Request and Response do: a Cloudflare Worker (see ../workers/),
// Deno, Bun, or Node 22.
//
// POST a .moca archive as the body; the answer is what the reference Reader
// concludes about it. The archive is read in memory and dropped: it is never
// stored, logged or sent anywhere. Nothing is fetched on the caller's behalf,
// so member packages are not resolved, and the caller cannot supply a trust
// root, so signatures are reported as unverifiable.
import { readPackage, archiveSource, Diagnostics, TargetError, formatSarif, countBySeverity } from '@openmoca/moca-core';

/** The host's limits. Tighter than the Reader's defaults: an upload is untrusted. */
export const DEFAULT_LINT_LIMITS = Object.freeze({
  maxBodyBytes: 10 * 1024 * 1024,
  maxEntries: 5_000,
  maxBytes: 64 * 1024 * 1024,
});

/**
 * Checks one limit. A limit that is not given (undefined, null or an empty
 * string) takes its default; anything else must be a positive whole number,
 * given as a number or as a string of digits. A wrong value is refused, never
 * read as "no limit".
 *
 * @param {string} name  the limit's name, for the error message
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
export function checkLimit(name, value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
    throw new RangeError(`${name} must be a positive whole number.`);
  }
  return n;
}

/**
 * The limits to use: each one given, or its default. Throws for a value that
 * is not a positive whole number.
 *
 * @param {{ maxBodyBytes?: unknown, maxEntries?: unknown, maxBytes?: unknown }} [limits]
 */
export function resolveLintLimits(limits = {}) {
  return Object.freeze({
    maxBodyBytes: checkLimit('maxBodyBytes', limits.maxBodyBytes, DEFAULT_LINT_LIMITS.maxBodyBytes),
    maxEntries: checkLimit('maxEntries', limits.maxEntries, DEFAULT_LINT_LIMITS.maxEntries),
    maxBytes: checkLimit('maxBytes', limits.maxBytes, DEFAULT_LINT_LIMITS.maxBytes),
  });
}

/** What the result cannot say, given with every answer so nobody reads too much into it. */
export const LINT_NOTES = Object.freeze([
  'Signatures and reviews are reported as unverifiable: this endpoint has no trust root for your package.',
  'Member packages are not fetched, so they are reported as unresolved.',
]);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(status, value, headers = {}) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { 'Content-Type': 'application/json', ...CORS, ...headers } });
}

/** A short JSON error with a stable code, so a client can tell the cases apart. */
export function errorResponse(status, code, message, headers = {}) {
  return json(status, { error: { code, message } }, headers);
}

/**
 * Reads a request body up to a limit. A body over the limit is refused before
 * it is all read, whatever Content-Length claims.
 *
 * @returns {Promise<Uint8Array|null>} the bytes, or null when over the limit
 */
export async function readLimited(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * Lints archive bytes with the reference Reader, under the given limits.
 *
 * @param {Uint8Array} bytes
 * @param {{ strict?: boolean, maxEntries?: number, maxBytes?: number }} [options]
 */
export async function lintArchive(bytes, { strict = false, maxEntries, maxBytes } = {}) {
  const resolved = resolveLintLimits({ maxEntries, maxBytes });
  const limits = { maxEntries: resolved.maxEntries, maxBytes: resolved.maxBytes };
  let source;
  try {
    // The zip library inflates each entry only up to its declared size, and the
    // source caps the declared total, so an archive cannot expand past maxBytes.
    source = archiveSource(Buffer.from(bytes), limits);
    source.list();
  } catch (err) {
    if (!(err instanceof TargetError)) throw err;
    const diagnostics = new Diagnostics({ strict });
    diagnostics.add(err.code, err.message);
    return { package: null, diagnostics: diagnostics.items, ok: false };
  }
  const result = await readPackage(source, { strict, limits });
  const diagnostics = [...result.diagnostics];
  return {
    package: result.manifest ? { id: result.manifest.id, version: result.manifest.version, digest: result.digest } : null,
    diagnostics,
    ok: !diagnostics.some((d) => d.severity === 'error'),
  };
}

/**
 * @param {object} [p]
 * @param {string} [p.path]  where the endpoint answers (default /lint)
 * @param {number|string} [p.maxBodyBytes]
 * @param {number|string} [p.maxEntries]
 * @param {number|string} [p.maxBytes]  the most an archive may expand to
 *   Each limit not given takes its default (DEFAULT_LINT_LIMITS). A value that
 *   is not a positive whole number throws a RangeError here, at set-up.
 * @param {(request: Request) => boolean | Promise<boolean>} [p.allow]
 *   the host's rate limit: false refuses the request with 429. Called before the body is read
 * @returns {(request: Request) => Promise<Response>}
 */
export function createLintHandler({ path = '/lint', allow, maxBodyBytes: body, maxEntries: entries, maxBytes: expanded } = {}) {
  const { maxBodyBytes, maxEntries, maxBytes } = resolveLintLimits({ maxBodyBytes: body, maxEntries: entries, maxBytes: expanded });

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== path) return errorResponse(404, 'not_found', `The lint endpoint is ${path}.`);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
    if (request.method !== 'POST') return errorResponse(405, 'method_not_allowed', 'POST a .moca archive as the body.', { Allow: 'POST, OPTIONS' });
    const format = url.searchParams.get('format') ?? 'json';
    if (!['json', 'sarif'].includes(format)) return errorResponse(400, 'unknown_format', 'format is json or sarif.');
    if (allow && !(await allow(request))) return errorResponse(429, 'rate_limited', 'Too many requests. Try again in a minute.', { 'Retry-After': '60' });

    const bytes = await readLimited(request, maxBodyBytes);
    if (bytes === null) return errorResponse(413, 'body_too_large', `The archive is over ${maxBodyBytes} bytes.`);
    if (bytes.byteLength === 0) return errorResponse(400, 'empty_body', 'POST a .moca archive as the body.');

    let lint;
    try {
      lint = await lintArchive(bytes, { strict: url.searchParams.get('strict') === 'true', maxEntries, maxBytes });
    } catch {
      // The Reader reports what is wrong with a package as diagnostics. An exception is a bug in the Reader:
      // answer plainly, and never echo its message, which could quote the upload.
      return errorResponse(500, 'internal_error', 'The archive could not be checked.');
    }
    if (format === 'sarif') return json(200, JSON.parse(formatSarif(lint.diagnostics)));
    return json(200, { ok: lint.ok, package: lint.package, diagnostics: lint.diagnostics, summary: countBySeverity(lint.diagnostics), notes: LINT_NOTES });
  };
}
