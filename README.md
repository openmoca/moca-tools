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

The tests read moca-spec's examples and fixtures. Check out moca-spec and
moca-reader-typescript beside this repository, or set `MOCA_SPEC_DIR`.
CI uses the tags pinned at the top of `.github/workflows/test.yml`
(`MOCA_SPEC_REF` and the like); check out the same tags to match it.

```sh
(cd ../moca-reader-typescript && npm install)
npm install
npm test
```

Until `@openmoca/moca-core` is on npm, each package depends on it as
`file:../../../moca-reader-typescript`. Change these to a version range before
the first publish.

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
5. Tag `vX.Y.Z` and publish a GitHub release whose notes are the changelog
   section.
6. From each package folder, at the tagged commit: `npm publish --access public`.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

OpenMOCA™ is a trade mark of PI & Mash Solutions Ltd. The licence covers the
code, not the name: see the
[trade mark policy](https://github.com/openmoca/moca-spec/blob/main/TRADEMARKS.md).
