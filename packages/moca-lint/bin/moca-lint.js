#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { formatText, formatJson, formatSarif, readPackage, structureView } from '@openmoca/moca-core';
import { lintPackage, packPackage, extractArchive, UsageError } from '../lib/index.js';

/** Encrypted packages: the age decryptor and a key provider from --identity or --passphrase-env, loaded only when asked. */
async function envelopeOptions(opts) {
  if (!opts.identity?.length && !opts.passphraseEnv) return {};
  const { ageDecryptor } = await import('@openmoca/moca-core/age');
  if (opts.identity?.length) {
    const identities = opts.identity.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('AGE-SECRET-KEY-1')));
    if (identities.length === 0) throw new UsageError(`no AGE-SECRET-KEY-1 identity in ${opts.identity.join(', ')}`);
    return { decryptor: ageDecryptor, keyProvider: () => ({ identities }) };
  }
  const passphrase = process.env[opts.passphraseEnv];
  if (!passphrase) throw new UsageError(`the environment variable ${opts.passphraseEnv} is not set`);
  return { decryptor: ageDecryptor, keyProvider: () => ({ passphrase }) };
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();
program.name('moca-lint').description('Check MOCA packages exactly as the reference Reader reads them.').version(version);

const common = (cmd) => cmd
  .option('--trust-root <file>', 'trust root used to verify attestations')
  .option('--members <dirs...>', 'directories to search for member packages')
  .option('--strict', 'treat warnings as errors', false)
  .option('--identity <file>', 'open an envelope with this age identity file; repeat for several', (v, a) => [...a, v], [])
  .option('--passphrase-env <name>', 'open an envelope with the passphrase in this environment variable');

function render(items, format, extra) {
  if (format === 'json') return formatJson(items, extra);
  if (format === 'sarif') return formatSarif(items);
  return formatText(items, { color: process.stdout.isTTY });
}

common(program.command('lint')
  .argument('<target>', 'package directory or .moca archive')
  .option('--sidecar <path>', 'also check a sidecar index against the package')
  .option('--vocabulary <file>', 'report how tags and structure concepts match a SKOS vocabulary (Turtle, or a .moca with a structure.ttl)')
  .option('--format <fmt>', 'text | json | sarif', 'text')
  .option('--output <file>', 'write the report to a file'))
  .action((target, opts) => run(async () => {
    const linted = await lintPackage({
      target, trustRoot: opts.trustRoot, memberDirs: opts.members, sidecar: opts.sidecar, strict: opts.strict,
      envelope: await envelopeOptions(opts),
    });
    const { result, diagnostics } = linted;
    let { ok } = linted;
    if (opts.vocabulary) {
      // Loaded only when asked, so the Workers build never parses Turtle for this.
      const { loadVocabulary, vocabularyDiagnostics } = await import('../lib/vocabulary.js');
      let vocabulary;
      try {
        vocabulary = await loadVocabulary(opts.vocabulary);
      } catch (err) {
        throw new UsageError(`--vocabulary: ${err.message}`);
      }
      const found = vocabularyDiagnostics(result, vocabulary, opts.strict);
      diagnostics.push(...found);
      if (found.some((d) => d.severity === 'error')) ok = false;
    }
    const extra = { package: result.manifest ? { id: result.manifest.id, version: result.manifest.version } : null, digest: result.digest, capabilities: result.capabilities };
    const report = render(diagnostics, opts.format, extra);
    if (opts.output) writeFileSync(opts.output, report);
    else console.log(report);
    if (result.envelope && !result.envelope.opened && !opts.identity?.length && !opts.passphraseEnv) {
      console.error('\nThis is an envelope. Pass --identity <file> or --passphrase-env <name> to open it.');
    }
    if (opts.format === 'text' && !opts.output && result.valid) {
      console.log(`\n${result.digest}\ncapabilities: ${result.capabilities.join(', ')}`);
    }
    process.exitCode = ok ? 0 : 1;
  }));

program.command('digest')
  .description('print the digest of a package (moca-digest-v2)')
  .argument('<target>', 'package directory or .moca archive')
  .action((target) => run(async () => {
    const result = await readPackage(target);
    if (!result.digest) {
      console.error(formatText(result.diagnostics.filter((d) => d.severity === 'error')));
      process.exitCode = 1;
      return;
    }
    console.log(result.digest);
  }));

program.command('manifest')
  .description('print the BagIt-style manifest the digest is computed over; save it outside the package and check with shasum -a 256 -c')
  .argument('<target>', 'package directory or .moca archive')
  .action((target) => run(async () => {
    const result = await readPackage(target);
    if (!result.payloadManifest) {
      console.error(formatText(result.diagnostics.filter((d) => d.severity === 'error')));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(result.payloadManifest);
  }));

program.command('structure')
  .description('print a sorted JSON view of structure.ttl (for reading; it is not a package file)')
  .argument('<target>', 'package directory or .moca archive')
  .action((target) => run(async () => {
    const result = await readPackage(target);
    if (!result.structure?.graph) {
      console.error('the package has no parseable structure.ttl');
      console.error(formatText(result.diagnostics.filter((d) => d.code.startsWith('O'))));
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(structureView(result.structure.graph), null, 2)}\n`);
  }));

program.command('info')
  .description('summarise a package: identity, capabilities, nodes, attestations')
  .argument('<target>', 'package directory or .moca archive')
  .option('--trust-root <file>', 'trust root used to verify attestations')
  .option('--identity <file>', 'open an envelope with this age identity file; repeat for several', (v, a) => [...a, v], [])
  .option('--passphrase-env <name>', 'open an envelope with the passphrase in this environment variable')
  .action((target, opts) => run(async () => {
    const r = await readPackage(target, { trustRoot: opts.trustRoot, ...(await envelopeOptions(opts)) });
    console.log(JSON.stringify({
      id: r.manifest?.id,
      version: r.manifest?.version,
      digest: r.digest,
      valid: r.valid,
      capabilities: r.capabilities,
      distribution: r.distribution,
      ...(r.envelope ? { envelope: r.envelope } : {}),
      nodes: r.nodes.map((n) => ({ path: n.path, type: n.representations[0].frontmatter.type, locales: n.representations.map((x) => x.locale ?? 'default') })),
      members: r.members.map(({ id, version: v, digest, status }) => ({ id, version: v, digest, status })),
      attestations: r.attestations.map(({ file, role, outcome, signer }) => ({ file, role, outcome, signer })),
      profiles: r.profiles,
    }, null, 2));
  }));

common(program.command('pack')
  .description('lint, then write a .moca archive (nothing is written if lint fails)')
  .argument('<dir>', 'package directory')
  .requiredOption('-o, --out <file>', 'archive to write'))
  .action((dir, opts) => run(async () => {
    const out = await packPackage({ dir, out: opts.out, trustRoot: opts.trustRoot, memberDirs: opts.members, strict: opts.strict });
    if (!out.written) {
      console.error(formatText(out.diagnostics));
      console.error('\nNot packed: fix the errors above.');
      process.exitCode = 1;
      return;
    }
    const warnings = out.diagnostics.filter((d) => d.severity === 'warning');
    if (warnings.length > 0) console.error(formatText(warnings));
    console.log(`Wrote ${opts.out}\n${out.result.digest}`);
  }));

program.command('extract')
  .description('safely extract a .moca archive')
  .argument('<archive>', '.moca or .zip archive')
  .requiredOption('-o, --out <dir>', 'destination directory')
  .action((archive, opts) => run(() => {
    const n = extractArchive({ archive, out: opts.out });
    console.log(`Extracted ${n} file(s) to ${opts.out}`);
  }));

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`moca-lint: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

program.parseAsync(process.argv);
