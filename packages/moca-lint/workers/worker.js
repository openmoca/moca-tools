// moca-lint as a Cloudflare Worker: POST a .moca archive to /lint. The archive
// is read in memory and dropped; nothing is stored, logged or fetched.
import { createLintHandler } from '@openmoca/moca-lint/http';

const number = (value) => (value ? Number(value) : undefined);
let handler;

export default {
  fetch(request, env) {
    handler ??= createLintHandler({
      maxBodyBytes: number(env.MOCA_LINT_MAX_BODY_BYTES),
      maxEntries: number(env.MOCA_LINT_MAX_ENTRIES),
      maxBytes: number(env.MOCA_LINT_MAX_BYTES),
      // The client address is only the rate limit's key. It is not logged.
      allow: env.RATE_LIMITER
        ? async (r) => (await env.RATE_LIMITER.limit({ key: r.headers.get('CF-Connecting-IP') ?? 'unknown' })).success
        : undefined,
    });
    return handler(request);
  },
};
