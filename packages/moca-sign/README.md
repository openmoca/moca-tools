# @openmoca/moca-sign

Writes and verifies MOCA [attestations](https://github.com/openmoca/moca-spec/blob/main/spec/moca-attestations.md):
package attestations for publishers and review attestations for reviewers.

```sh
moca-sign keygen --keyid <id> --out <dir> [--roles package,review] [--identity text] [--expires date]
moca-sign sign <package> (--key <pem> --keyid <id> | --sigstore)
moca-sign review <package> --nodes <paths...> --reviewer <actor> [--outcome accurate|needs-change|inaccurate] [--scope text] [--note text] [--at iso] (--key <pem> --keyid <id> | --sigstore)
moca-sign verify <package> --trust-root <file> [--online] [--allow-offline-fallback] [--tuf-cache dir]
moca-sign trust add <trust-root> --keyid <id> --public-key <pem> [--identity text] [--roles package,review] [--expires date]
moca-sign trust add <trust-root> --issuer <url> --subject <identity> [--roles package,review]
moca-sign trust list <trust-root>
moca-sign trust remove <trust-root> (--keyid <id> | --issuer <url> --subject <identity>)
```

- `keygen` creates an Ed25519 key pair and adds the public key to
  `<dir>/trust-root.json`. Never put a private key in a package.
- `sign` writes `attestations/package.<keyid>.dsse.json` (or
  `package.sigstore.json`). It refuses to sign an invalid package.
- `review` writes `attestations/reviews/<reviewer>-<date>.dsse.json`, binding
  the review to each node file's exact SHA-256.
- `verify` checks every attestation and exits 0 only if all verify and at least
  one package attestation is valid.
- `trust` edits a reader's trust root: whose signatures it accepts, and for
  what. `trust add` takes a signer's public key or Sigstore identity, which the
  signer gives you over a channel you already trust. It creates the file if
  needed, replaces an entry with the same key id or identity, and checks the
  result against the trust-root schema. It refuses a private key, and any key
  that is not Ed25519: MOCA DSSE keys are Ed25519 (attestations §5).
  `trust list` shows what is trusted and marks expired keys.

```sh
# Trust Acme's publishing key, for packages, until it expires
moca-sign trust add trust-root.json --keyid acme-publisher --public-key acme-publisher.pub.pem \
  --identity "Acme publishing key" --roles package --expires 2027-11-01

# Trust packages that Acme's GitHub workflow signs with Sigstore
moca-sign trust add trust-root.json --issuer https://token.actions.githubusercontent.com \
  --subject https://github.com/acme/kb/.github/workflows/publish.yml@refs/heads/main --roles package

moca-sign trust list trust-root.json
```

```text
key       package  acme-publisher (Acme publishing key, expires 2027-11-01T00:00:00Z)
sigstore  package  https://github.com/acme/kb/.github/workflows/publish.yml@refs/heads/main (issuer https://token.actions.githubusercontent.com)
```

Sigstore signing needs an OIDC identity: in GitHub Actions, grant
`id-token: write`. DSSE signatures are deterministic, which the repository uses
to regenerate its example attestations.
