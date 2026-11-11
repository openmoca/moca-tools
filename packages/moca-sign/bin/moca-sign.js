#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  generateKeyPair, signPackage, reviewNodes, verifyPackage, SignError,
  readTrustRoot, writeTrustRoot, addKey, addSigstoreIdentity, removeEntry, describeTrustRoot, checkPublicKey,
  parseRoles, parseExpires, TrustRootError,
} from '../lib/index.js';
import { formatText } from '../lib/deps.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();
program
  .name('moca-sign')
  .description('Write and verify MOCA package and review attestations (DSSE or Sigstore).')
  .version(version);

const keyOptions = (cmd) => cmd
  .option('--key <pem>', 'Ed25519 private key (PKCS#8 PEM) for DSSE signing')
  .option('--keyid <id>', 'key id recorded in the DSSE envelope; must match the verifier trust root')
  .option('--sigstore', 'sign keyless with Sigstore (needs an OIDC identity, e.g. in CI)', false);

function keyArgs(opts) {
  if (opts.sigstore) return { sigstore: true };
  if (!opts.key || !opts.keyid) throw new SignError('pass --key and --keyid, or --sigstore');
  return { privateKeyPem: readFileSync(opts.key, 'utf8'), keyid: opts.keyid };
}

program.command('keygen')
  .description('generate an Ed25519 key pair and add it to <out>/trust-root.json (created if missing)')
  .requiredOption('--keyid <id>', 'key id')
  .requiredOption('-o, --out <dir>', 'output directory')
  .option('--identity <text>', 'human-readable label for the key')
  .option('--roles <roles>', 'comma-separated roles the key may sign for: package,review')
  .option('--expires <date>', 'when readers stop trusting the key, e.g. 2027-01-01')
  .action((opts) => run(() => {
    const roles = parseRoles(opts.roles);
    const expires = parseExpires(opts.expires);
    const { privateKeyPem, publicKeyPem } = generateKeyPair();
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, `${opts.keyid}.pem`), privateKeyPem, { mode: 0o600 });
    writeFileSync(join(opts.out, `${opts.keyid}.pub.pem`), publicKeyPem);
    const rootPath = join(opts.out, 'trust-root.json');
    const { doc } = addKey(readTrustRoot(rootPath), { keyid: opts.keyid, publicKey: publicKeyPem, identity: opts.identity, roles, expires });
    writeTrustRoot(rootPath, doc);
    console.log(`Wrote ${opts.keyid}.pem and ${opts.keyid}.pub.pem, and added the key to ${rootPath}. Keep private keys out of every package.`);
  }));

// A reader's trust root: whose signatures it accepts, and for what (spec/moca-attestations.md section 6).
const trust = program.command('trust')
  .description('add, list or remove the keys and Sigstore identities in a trust root');

trust.command('add')
  .description('trust a publisher or reviewer: a public key (--keyid, --public-key) or a Sigstore identity (--issuer, --subject)')
  .argument('<trust-root>', 'trust-root JSON file (created if missing)')
  .option('--keyid <id>', 'the key id the signer uses')
  .option('--public-key <pem>', 'the signer\'s public key file (PEM), such as their .pub.pem')
  .option('--identity <text>', 'a name for the key, shown as the signer')
  .option('--expires <date>', 'stop trusting the key after this date, e.g. 2027-01-01')
  .option('--issuer <url>', 'Sigstore: the OIDC issuer, e.g. https://token.actions.githubusercontent.com')
  .option('--subject <identity>', 'Sigstore: the identity it signs as, e.g. a workflow address or an email')
  .option('--roles <roles>', 'what it may sign: package, review, or package,review (default: both)')
  .action((path, opts) => run(() => {
    const roles = parseRoles(opts.roles);
    const isKey = opts.keyid !== undefined || opts.publicKey !== undefined;
    const isSigstore = opts.issuer !== undefined || opts.subject !== undefined;
    if (isKey === isSigstore) throw new TrustRootError('add either a key (--keyid and --public-key) or a Sigstore identity (--issuer and --subject)');
    const before = readTrustRoot(path);
    if (isKey) {
      if (!opts.keyid || !opts.publicKey) throw new TrustRootError('a key needs both --keyid and --public-key');
      const { pem } = checkPublicKey(readFileSync(opts.publicKey, 'utf8'));
      const expires = parseExpires(opts.expires);
      const { doc, replaced } = addKey(before, { keyid: opts.keyid, publicKey: pem, identity: opts.identity, roles, expires });
      writeTrustRoot(path, doc);
      console.log(`${replaced ? 'Replaced' : 'Added'} key ${opts.keyid} in ${path}, trusted for ${(roles ?? ['package', 'review']).join(' and ')}.`);
      if (expires && Date.parse(expires) < Date.now()) console.warn(`moca-sign: warning: the key expired on ${expires}, so nothing it signed will verify.`);
    } else {
      if (opts.expires !== undefined || opts.identity !== undefined) throw new TrustRootError('--expires and --identity are for keys; a Sigstore identity is named by --subject');
      const { doc, replaced } = addSigstoreIdentity(before, { issuer: opts.issuer, subject: opts.subject, roles });
      writeTrustRoot(path, doc);
      console.log(`${replaced ? 'Replaced' : 'Added'} Sigstore identity ${opts.subject} in ${path}, trusted for ${(roles ?? ['package', 'review']).join(' and ')}.`);
    }
  }));

trust.command('list')
  .description('list the keys and Sigstore identities a trust root trusts')
  .argument('<trust-root>', 'trust-root JSON file')
  .action((path) => run(() => {
    if (!existsSync(path)) throw new TrustRootError(`${path} does not exist`);
    const lines = describeTrustRoot(readTrustRoot(path));
    console.log(lines.length > 0 ? lines.join('\n') : `${path} trusts nobody yet.`);
  }));

trust.command('remove')
  .description('stop trusting a key (--keyid) or a Sigstore identity (--issuer and --subject)')
  .argument('<trust-root>', 'trust-root JSON file')
  .option('--keyid <id>', 'the key to remove')
  .option('--issuer <url>', 'Sigstore: the issuer of the identity to remove')
  .option('--subject <identity>', 'Sigstore: the identity to remove')
  .action((path, opts) => run(() => {
    if (!existsSync(path)) throw new TrustRootError(`${path} does not exist`);
    const { doc, removed } = removeEntry(readTrustRoot(path), { keyid: opts.keyid, issuer: opts.issuer, subject: opts.subject });
    if (!removed) throw new TrustRootError(`${path} has no such ${opts.keyid ? `key ${opts.keyid}` : `identity ${opts.subject}`}`);
    writeTrustRoot(path, doc);
    console.log(`Removed ${opts.keyid ? `key ${opts.keyid}` : `Sigstore identity ${opts.subject}`} from ${path}.`);
  }));

keyOptions(program.command('sign')
  .description('attest that this exact package is published by you (writes attestations/package.*.json)')
  .argument('<package>', 'package directory'))
  .action((dir, opts) => run(async () => {
    const out = await signPackage({ dir, ...keyArgs(opts) });
    console.log(`Signed ${out.digest}\nWrote ${out.file}`);
  }));

keyOptions(program.command('review')
  .description('attest that a reviewer checked these exact node files (writes attestations/reviews/*.json)')
  .argument('<package>', 'package directory')
  .requiredOption('--nodes <paths...>', 'node paths relative to content/')
  .requiredOption('--reviewer <actor>', 'OKF actor, e.g. human:jane.doe')
  .option('--outcome <outcome>', 'accurate | needs-change | inaccurate', 'accurate')
  .option('--at <iso>', 'review time (default: now)')
  .option('--scope <text>', 'what the review covered')
  .option('--note <text>', 'free-text note')
  .option('--name <stem>', 'file name stem under attestations/reviews/'))
  .action((dir, opts) => run(async () => {
    if (!['accurate', 'needs-change', 'inaccurate'].includes(opts.outcome)) throw new SignError(`unknown outcome ${opts.outcome}`);
    const out = await reviewNodes({
      dir, nodes: opts.nodes, reviewer: opts.reviewer, outcome: opts.outcome, reviewedAt: opts.at,
      scope: opts.scope, note: opts.note, name: opts.name, ...keyArgs(opts),
    });
    console.log(`Reviewed ${out.files.map((f) => f.path).join(', ')}\nWrote ${out.file}`);
  }));

program.command('verify')
  .description('verify every attestation in a package against a trust root')
  .argument('<package>', 'package directory or .moca archive')
  .requiredOption('--trust-root <file>', 'trust-root JSON (spec/moca-attestations.md section 6)')
  .option('--online', 'also check the live Sigstore transparency log', false)
  .option('--allow-offline-fallback', 'degrade to offline checks if online verification cannot complete', false)
  .option('--tuf-cache <dir>', 'pinned Sigstore TUF cache directory')
  .action((dir, opts) => run(async () => {
    const result = await verifyPackage({
      dir, trustRoot: opts.trustRoot, online: opts.online, allowOfflineFallback: opts.allowOfflineFallback, tufCachePath: opts.tufCache,
    });
    for (const a of result.attestations) {
      const status = a.outcome === 'valid' && a.outdated?.length && !a.current?.length ? 'outdated' : a.outcome;
      console.log(`${status.toUpperCase().padEnd(13)} ${a.file}${a.signer ? `  (${a.signer})` : ''}${a.reason ? `  ${a.reason}` : ''}`);
    }
    const relevant = result.diagnostics.filter((d) => /^(A|T|P|M)\d/.test(d.code));
    if (relevant.length > 0) console.log(`\n${formatText(relevant)}`);
    console.log(result.ok ? `\nVerified ${result.digest}` : '\nVerification failed.');
    process.exitCode = result.ok ? 0 : 1;
  }));

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SignError || err instanceof TrustRootError) {
      console.error(`moca-sign: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

program.parseAsync(process.argv);
