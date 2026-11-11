#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { formatText, formatJson, formatSarif, readPackage, structureView } from '@openmoca/moca-core';
import { lintPackage, packPackage, extractArchive, UsageError } from '../lib/index.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();
program.name('moca-lint').description('Check MOCA packages exactly as the reference Reader reads them.').version(version);

const common = (cmd) => cmd
  .option('--trust-root <file>', 'trust root used to verify attestations')
  .option('--members <dirs...>', 'directories to search for member packages')
  .option('--strict', 'treat warnings as errors', false);

function render(items, format, extra) {
  if (format === 'json') return formatJson(items, extra);
  if (format === 'sarif') return formatSarif(items);
  return formatText(items, { color: process.stdout.isTTY });
}

common(program.command('lint')
  .argument('<target>', 'package directory or .moca archive')
  .option('--sidecar <path>', 'also check a sidecar index against the package')
  .option('--format <fmt>', 'text | json | sarif', 'text')
  .option('--output <file>', 'write the report to a file'))
  .action((target, opts) => run(async () => {
    const { result, diagnostics, ok } = await lintPackage({
      target, trustRoot: opts.trustRoot, memberDirs: opts.members, sidecar: opts.sidecar, strict: opts.strict,
    });
    const extra = { package: result.manifest ? { id: result.manifest.id, version: result.manifest.version } : null, digest: result.digest, capabilities: result.capabilities };
    const report = render(diagnostics, opts.format, extra);
    if (opts.output) writeFileSync(opts.output, report);
    else console.log(report);
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
  .action((target, opts) => run(async () => {
    const r = await readPackage(target, { trustRoot: opts.trustRoot });
    console.log(JSON.stringify({
      id: r.manifest?.id,
      version: r.manifest?.version,
      digest: r.digest,
      valid: r.valid,
      capabilities: r.capabilities,
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
