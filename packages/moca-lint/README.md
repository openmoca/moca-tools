# @openmoca/moca-lint

Checks packages exactly as the reference Reader reads them, and packs and
extracts `.moca` archives.

```sh
moca-lint lint <package> [--trust-root f] [--members dirs...] [--sidecar path] [--strict] [--format text|json|sarif] [--output f]
moca-lint digest <package>
moca-lint manifest <package> > <package>.manifest-sha256.txt
moca-lint info <package> [--trust-root f]
moca-lint pack <dir> -o <file.moca> [--trust-root f] [--members dirs...] [--strict]
moca-lint extract <archive> -o <dir>
moca-lint structure <package>
```

- `lint` exits 1 when there is any error-severity diagnostic, 0 otherwise.
  Codes are listed in [Reader contract §11](https://github.com/openmoca/moca-spec/blob/main/spec/moca-reader-contract.md#11-diagnostics).
- `digest` prints the package digest (`moca-digest-v2`); it is the same for a
  folder and its archive.
- `manifest` prints the BagIt-style manifest the digest is the SHA-256 of.
  Saved outside the package, it checks every file with
  `shasum -a 256 -c` or `sha256sum -c`.
- `pack` writes nothing if lint fails. The archive contains the package's
  regular files and its `attestations/`; hidden entries are left out.
- `extract` applies the Reader's archive checks before writing anything.
- `structure` prints a sorted JSON view of `structure.ttl`, for reading. It
  never writes into the package.
- `--format sarif` produces a report for code-scanning tools.

Besides the Reader's codes, `lint` adds one check of its own:
`LINT_RETIRED_CONCEPT` (warning) for a page whose `primary` concept is
`owl:deprecated` or replaced (`dcterms:replaces`, `isReplacedBy`), while the
page is neither `status: deprecated` nor bounded by its own `moca.valid_until`.
Structure never hides content, so that page is still retrieved. The warning
names the replacing concept and the pages bound to it.

From a checkout of moca-tools: `node packages/moca-lint/bin/moca-lint.js ...`.

## Over HTTP, and on Cloudflare Workers

`@openmoca/moca-lint/http` answers lint requests as a web-standard fetch
handler. It runs wherever `Request` and `Response` do: Cloudflare Workers,
Deno, Bun or Node 22.

```js
import { createLintHandler } from '@openmoca/moca-lint/http';

const handler = createLintHandler({ allow: async (request) => true }); // your rate limit; false answers 429
// handler(request) => Promise<Response>
```

```sh
curl --data-binary @support-kb.moca -H 'Content-Type: application/zip' https://<your host>/lint
curl --data-binary @support-kb.moca 'https://<your host>/lint?format=sarif&strict=true'
```

- **The answer** is what the reference Reader concludes: `ok`, the package's id,
  version and digest, the diagnostics and a summary. `?format=sarif` gives SARIF.
- **What it cannot check is said in every answer** (`notes`): there is no trust
  root for your package, so signatures and reviews are unverifiable (`A003`),
  and member packages are not fetched.
- **Limits for an untrusted upload:** a 10 MB body, 5,000 entries and 64 MB
  expanded (`maxBodyBytes`, `maxEntries`, `maxBytes`). The zip library inflates
  each entry only up to its declared size, and the Reader caps the declared
  total, so an archive cannot expand past the limit. An archive whose sizes lie
  is `P002_UNREADABLE_ENTRY`.
- **Nothing is kept.** The archive is read in memory and dropped. It is never
  stored, logged or sent anywhere.
- Errors are short JSON with a stable code: `not_found`, `method_not_allowed`,
  `unknown_format`, `rate_limited`, `empty_body`, `body_too_large`,
  `internal_error`.

### Run your own on Cloudflare Workers

`workers/` is a generic target. It names no account, route or limit.

```sh
npm ci
npx wrangler dev -c packages/moca-lint/workers/wrangler.toml      # http://localhost:8787/lint
npx wrangler deploy -c packages/moca-lint/workers/wrangler.toml   # to your own account
```

Set limits and a rate limit in your copy of `workers/wrangler.toml`. Linting a
large package takes more CPU than the Workers Free plan's 10 ms a request: a
1,655-file package (4 MB zipped) took about 190 ms on a laptop.

`npm run test:workers -w @openmoca/moca-lint` runs the target in workerd,
Cloudflare's runtime.
