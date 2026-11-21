# moca-tools

Command-line tools for MOCA packages. Each is published to npm on its own.

| Package | Purpose |
| --- | --- |
| [`@openmoca/moca-lint`](packages/moca-lint#readme) | Check, pack, extract; print digests, manifests and structure views |
| [`@openmoca/moca-index`](packages/moca-index#readme) | Build and check sidecar indexes |
| [`@openmoca/moca-embed`](packages/moca-embed#readme) | MOCA's standard embedding models, run locally: install them, and embed for `moca-index --model` and the Readers |
| [`@openmoca/moca-sign`](packages/moca-sign#readme) | Publisher and review attestations (DSSE or Sigstore) |

They use the reference Reader,
[`@openmoca/moca-core`](https://github.com/openmoca/moca-reader-typescript).
The specification is in [moca-spec](https://github.com/openmoca/moca-spec).

## Develop

The tests read moca-spec's examples and fixtures. Check out moca-spec beside
this repository, or set `MOCA_SPEC_DIR`. While a Spec Change Proposal is in
flight, the packages depend on `@openmoca/moca-core` as
`file:../../../moca-reader-typescript`, so check that out beside this
repository too and run `npm install` in it first.
CI uses the tags pinned at the top of `.github/workflows/test.yml`
(`MOCA_SPEC_REF` and the like); check out the same tags to match it.

```sh
npm install
npm test
```

## Release

The four packages share one version and one tag. Publish `@openmoca/moca-embed` before `@openmoca/moca-index`, which
depends on it.

1. Publish `@openmoca/moca-core` first if it changed.
2. Update each package's version, and set its `@openmoca/moca-core` dependency
   to the released range (it is a `file:` path until the first publish). Add a
   dated section to [CHANGELOG.md](CHANGELOG.md).
3. Point the `MOCA_*_REF` pins in `.github/workflows/test.yml` at the release tags
   ([moca-spec docs/releasing.md](https://github.com/openmoca/moca-spec/blob/main/docs/releasing.md#moving-the-pins)).
4. `npm test` passes.
5. Merge to main, tag `vX.Y.Z` on main and push the tag. The release workflow
   (`.github/workflows/release.yml`) checks that the versions match the tag and
   that the `@openmoca/moca-core` range is on npm, then publishes the four
   packages through trusted publishing, with provenance: `moca-embed`,
   `moca-sign` and `moca-lint`, then `moca-index`. No npm token is kept
   anywhere.
6. Publish a GitHub release whose notes are the changelog section.

## Standards

What these tools use, and how strongly. **Follow** means the tools implement it
and the tests check it where they can.

| Standard | Where | How strongly |
| --- | --- | --- |
| MOCA ([moca-spec](https://github.com/openmoca/moca-spec)) 0.7 | every tool, through the reference Reader `@openmoca/moca-core` | follow |
| [JSON Schema 2020-12](https://json-schema.org/draft/2020-12) | trust roots and manifests, checked against moca-spec's schemas | follow |
| [Ed25519](https://www.rfc-editor.org/rfc/rfc8032) (RFC 8032) and [in-toto Statement v1](https://github.com/in-toto/attestation) in [DSSE](https://github.com/secure-systems-lab/dsse) envelopes | `moca-sign`: package, review and issued-copy attestations | follow |
| [Sigstore](https://www.sigstore.dev/) bundles | `moca-sign sign --sigstore`, `review --sigstore`; `verify` compares issuer and subject exactly | follow |
| [age v1](https://age-encryption.org/v1) (X25519 and scrypt recipients) | `moca-sign encrypt` and `decrypt`, `moca-index --envelope` | follow |
| [ZIP](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) (stored and deflated entries) | `moca-lint pack` and `extract`, `.mocai` sidecars | follow |
| [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html) | `moca-lint lint --format sarif`, and the HTTP endpoint | follow |
| [SKOS](https://www.w3.org/TR/skos-reference/) in [RDF 1.1 Turtle](https://www.w3.org/TR/turtle/) | `moca-lint --vocabulary` | follow (the named terms) |
| [Fetch](https://fetch.spec.whatwg.org/) `Request` and `Response` | `@openmoca/moca-lint/http` | follow |
| [ONNX](https://onnx.ai/) | `moca-embed`: the standard embedding models | follow |

Built with the help of AI assistants; every change is reviewed and accepted by the maintainer.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenMOCA™ is a trade mark of PI & Mash Solutions Ltd. The licence covers the
code, not the name: see the
[trade mark policy](https://github.com/openmoca/moca-spec/blob/main/TRADEMARKS.md).
