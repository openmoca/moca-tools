# Changelog

All notable changes to `@openmoca/moca-lint`, `@openmoca/moca-index`, `@openmoca/moca-sign`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

For moca-spec 0.7.0 ([moca-spec#5](https://github.com/openmoca/moca-spec/issues/5)).

### Added (moca-lint, package spec §4.1)

- `pack` warns `LINT_DISTRIBUTION_PACKED_PLAIN` (an error with `--strict`)
  when the manifest's `distribution` is `encrypted-only`. `info` shows
  `distribution`.

### Changed

- While the proposal is open, the packages depend on the sibling
  moca-reader-typescript (`file:`), and CI checks it out at a pinned ref.

## [0.6.0] - 2026-11-11

### Changed (moca-sign trust add)

- `trust add` refuses an Ed25519 key that is a small-order or mixed-order
  point: it would verify nothing (moca-spec attestations §5).

### Added (moca-lint)

- `LINT_RETIRED_CONCEPT` (warning): a page whose primary concept is
  deprecated or replaced, while the page is neither `status: deprecated` nor
  bounded by its own `moca.valid_until`. It names the replacing concept and
  its pages (moca-spec ADR-0020).

### Changed (moca-lint structure)

- `moca-lint structure` only prints the sorted JSON view of `structure.ttl`.
  `--write` is gone: Readers no longer read `structure.json`
  (moca-spec ADR-0019).

### Changed (moca-sign tests)

- A signed package whose content changed after signing is reported as
  `A008_PACKAGE_DIGEST_MISMATCH` by the 0.6.0 Reader; the tests expect it.

### Changed (moca-sign)

- Trust roots always list `roles`, as attestations §6 now requires: `keygen`
  and `trust add` without `--roles` write `["package", "review"]` instead of
  leaving roles out.

## [0.5.0] - Not published

### Added (moca-embed, new)

- `@openmoca/moca-embed`: MOCA's four standard embedding models run locally,
  pinned by commit and SHA-256, with `standardEmbedder()` in the Reader's
  embedder shape and `moca-embed models list | add`. Vectors match the .NET
  Reader's ONNX binding and the MCP server exactly.

### Added (moca-index)

- `--model <name>` builds an index with one of MOCA's standard embedding models
  (`bge-small-en-v1.5`, `nomic-embed-text-v1.5`, `all-MiniLM-L6-v2`,
  `multilingual-e5-small`), read from a model store (`--models`, `MOCA_MODELS`
  or `~/.moca/models`) and checked against pinned SHA-256s. Vectors match the
  MOCA MCP server's embedder exactly. Needs the optional dependency
  `@huggingface/transformers`.
### Added

- moca-lint: `@openmoca/moca-lint/http`, `createLintHandler()` and
  `lintArchive()`. POST a `.moca` archive and get the reference Reader's
  diagnostics as JSON or SARIF. Limits for an untrusted upload (10 MB body,
  5,000 entries, 64 MB expanded), a host rate limit hook, and short JSON errors
  with stable codes. Every answer says what it cannot check: signatures without
  a trust root, and members.
- moca-lint: `workers/`, a generic, unconfigured Cloudflare Workers target.
  `npm run test:workers -w @openmoca/moca-lint` runs it in workerd.
- moca-index: `build --max-chars <n> [--overlap <n>]`. Splits any chunk longer
  than the limit, at a blank line, a line end, a sentence end or a space, so
  each chunk fits an embedding model's window. Offsets stay exact UTF-8 byte
  offsets. The limit is recorded in `index.json` `chunking`.
- moca-sign: `trust add`, `trust list` and `trust remove`, for a reader's
  trust root. `trust add` takes a signer's public key (`--keyid`,
  `--public-key`) or Sigstore identity (`--issuer`, `--subject`), with
  `--roles` and, for keys, `--identity` and `--expires`. It creates the file if
  needed, replaces an entry with the same key id or identity, checks the result
  against the trust-root schema, and refuses a private key or a key that is not
  Ed25519 (attestations §5 requires Ed25519 for DSSE). `trust list` marks
  expired keys.
- moca-sign: `keygen --expires`.

## [0.4.0-alpha.2] - 2026-10-30

The first release from this repository. It was previously part of moca-spec at 0.4.0-alpha.1.

### Added

- `moca-index build --embedder`: chunks are embedded with the role
  `document`, and the embedder's declared `queryPrefix` and `documentPrefix`
  are recorded in the index's `model`, for Readers to compare
  (moca-spec#12).
