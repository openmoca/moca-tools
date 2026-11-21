# @openmoca/moca-sign

Writes and verifies MOCA [attestations](https://github.com/openmoca/moca-spec/blob/main/spec/moca-attestations.md):
package attestations for publishers, review attestations for reviewers, and
issued-copy attestations for issuers.

```sh
moca-sign keygen --keyid <id> --out <dir> [--roles package,review] [--identity text] [--expires date]
moca-sign sign <package> (--key <pem> --keyid <id> | --sigstore)
moca-sign review <package> --nodes <paths...> --reviewer <actor> [--outcome accurate|needs-change|inaccurate] [--scope text] [--note text] [--at iso] [--name stem] (--key <pem> --keyid <id> | --sigstore)
moca-sign issue <copy> --original <dir> --key <pem> --keyid <id> [--trust-root <file>]
moca-sign verify <package> --trust-root <file> [--online] [--allow-offline-fallback] [--tuf-cache dir]
moca-sign trust add <trust-root> --keyid <id> --public-key <pem> [--identity text] [--roles package,review,issued-copy] [--ids ids] [--expires date]
moca-sign trust add <trust-root> --issuer <url> --subject <identity> [--roles package,review,issued-copy] [--ids ids]
moca-sign trust list <trust-root>
moca-sign trust remove <trust-root> (--keyid <id> | --issuer <url> --subject <identity>)
moca-sign encrypt <package> -o <file.mocae> (-r <age1...>... | -R <file>... | --passphrase-env <name> [--work-factor n]) [--outline id,version,title | --no-outline] [--structure] [--cover] [--force]
moca-sign decrypt <file.mocae> -o <file.moca> (-i <identity-file>... | --passphrase-env <name>) [--force]
```

- `keygen` creates an Ed25519 key pair and adds the public key to
  `<dir>/trust-root.json`. Never put a private key in a package. The key id
  names the files, so it is letters, digits, `.`, `_` and `-`. It never
  replaces a key: it refuses a key id whose files exist or that the trust root
  already lists. The private key file is readable by its owner only.
- `sign` writes `attestations/package.<keyid>.dsse.json` (or
  `package.sigstore.json`). It refuses to sign an invalid package. Key ids
  that differ only in case or punctuation give the same file name; `sign`
  refuses to replace a file signed with another key id.
- `review` writes `attestations/reviews/<reviewer>-<date>.dsse.json`, binding
  the review to each node file's exact SHA-256. `--name` chooses the file name
  stem: letters, digits, `.`, `_` and `-`, with no path.
- `issue` binds a marked copy to its publisher's package
  ([attestations §3a](https://github.com/openmoca/moca-spec/blob/main/spec/moca-attestations.md#3a-issued-copy-attestations)).
  Make the copy from the publisher's package, change the files you mark, then
  run `issue`. It compares the copy with the original, checks that only files
  under `content/` or `media/` changed and that the publisher's
  `issuedCopies` allows them, and writes
  `attestations/issued.<keyid>.dsse.json` with the original hash of each
  changed file. The original must carry a publisher signature for its own
  digest; with `--trust-root`, that signature must also verify. It copies the
  publisher's attestations into the copy if they
  are missing. It never marks anything, and it signs with a DSSE key only:
  keyless signing would put each issue in a public log. Keep your own record
  of which copy, by digest, went to whom.
- `verify` checks every attestation and exits 0 only if all verify and at least
  one package attestation is valid.
- `trust` edits a reader's trust root: whose signatures it accepts, and for
  what. `trust add` takes a signer's public key or Sigstore identity, which the
  signer gives you over a channel you already trust. It creates the file if
  needed, replaces an entry with the same key id or identity, and checks the
  result against the trust-root schema. It refuses a private key, and any key
  that is not Ed25519: MOCA DSSE keys are Ed25519 (attestations §5).
  `--roles issued-copy` lets an issuer bind copies, and needs `--ids`: the
  packages whose copies it may issue. It is never a default role.
- `encrypt` writes an envelope
  ([encrypted packages](https://github.com/openmoca/moca-spec/blob/main/spec/moca-encrypted-package.md)):
  the package as a `.moca` archive, encrypted with age v1 to X25519 recipients
  (`age1…`, from `age-keygen` or any age tool) or to one passphrase. Sign
  first, then encrypt: attestations travel inside. The outline leaves `id`,
  `version` and `title` readable unless you choose other fields or
  `--no-outline`. The outline may also carry `translations`, `tags` and `apps`, so
  a catalogue can show translated titles and offer "Open with" without the
  key. `--structure` also
  leaves `structure.ttl` readable, and warns that it reveals the concept
  graph; `--cover` leaves a copy of the first cover image readable
  (`outline/cover.png`, `.jpg` or `.webp`), and warns that anyone can see it. A passphrase is read only from an
  environment variable, and `--work-factor` is 15 to 20 (default 18): lower
  makes the passphrase cheap to guess, and Readers refuse more than 20. The
  envelope is written to a temporary file beside the output, checked as a
  Reader reads it, and only then moved into place; if the check fails, nothing
  is left. It refuses an invalid package. Encryption gives
  confidentiality only: anyone who can decrypt a copy can share its content.
- `decrypt` opens an envelope as a Reader does, with every check including
  the outline, and then **writes the plain `.moca` to disk**. It is a Producer
  tool; Readers never write decrypted bytes to a file.
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
`id-token: write`. Every Sigstore signature (`sign --sigstore`,
`review --sigstore`) is recorded in Sigstore's public transparency log, with
the signing identity and the signed statement's digest. `verify` uses the
reference Reader, which matches a trust root's Sigstore issuer and subject
exactly, as text (attestations §6): there are no patterns.

Every failure exits non-zero with one line on stderr: 2 for input moca-sign
refuses, 1 for anything else (a missing key file, a signing service error).
A build that signs never carries on with unsigned output. Set
`MOCA_SIGN_DEBUG=1` for the stack trace. DSSE signatures are deterministic, which the repository uses
to regenerate its example attestations.
