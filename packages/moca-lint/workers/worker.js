// moca-lint as a Cloudflare Worker: POST a .moca archive to /lint. The archive
// is read in memory and dropped; nothing is stored, logged or fetched.
import { createLintHandler, errorResponse } from '@openmoca/moca-lint/http';

let handler;

export default {
  fetch(request, env) {
    if (!handler) {
      try {
        // An unset limit takes moca-lint's default. A value that is not a positive whole number is refused:
        // every request then answers 500 until the setting is fixed, so a wrong setting never turns a limit off.
        handler = createLintHandler({
          maxBodyBytes: env.MOCA_LINT_MAX_BODY_BYTES,
          maxEntries: env.MOCA_LINT_MAX_ENTRIES,
          maxBytes: env.MOCA_LINT_MAX_BYTES,
          // The client address is only the rate limit's key. It is not logged.
          allow: env.RATE_LIMITER
            ? async (r) => (await env.RATE_LIMITER.limit({ key: r.headers.get('CF-Connecting-IP') ?? 'unknown' })).success
            : undefined,
        });
      } catch {
        return errorResponse(500, 'misconfigured', 'The lint service is not set up correctly.');
      }
    }
    return handler(request);
  },
};
