#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { readPackage, bindSidecar, formatText } from '@openmoca/moca-core';
import { buildSidecar, addEnvelopeIndex, IndexError, CHUNKERS } from '../lib/index.js';
import { readRecipients, passphraseFromEnv } from '@openmoca/moca-sign';
import { standardEmbedder, STANDARD_MODELS, defaultModelStore } from '@openmoca/moca-embed';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();
program.name('moca-index').description('Build and check moca-jsonl-v1 sidecar indexes.').version(version);

program.command('build')
  .argument('<package>', 'package directory or .moca archive')
  .option('-o, --out <path>', 'sidecar: a <name>.mocai archive, or any other name for a folder; keep it outside the package')
  .option('--envelope <file>', 'instead of -o: add the index to this envelope of the package, as index.age, encrypted to the recipients below')
  .option('-r, --recipient <age1...>', 'with --envelope: an X25519 recipient; repeat for several', (v, a) => [...a, v], [])
  .option('-R, --recipients-file <file>', 'with --envelope: a file of recipients, one per line', (v, a) => [...a, v], [])
  .option('--passphrase-env <name>', 'with --envelope: encrypt to one passphrase read from this environment variable')
  .option('--work-factor <n>', 'with --passphrase-env: scrypt work factor, log2 N', (v) => Number.parseInt(v, 10), 18)
  .option('--zip', 'write the Zip archive whatever the name (it is written for a .mocai name anyway)', false)
  .option('--chunk <mode>', `chunking: ${CHUNKERS.join(' | ')}`, 'node')
  .option('--max-chars <n>', 'split any chunk longer than this many characters (at a blank line, line, sentence or space)', toInt)
  .option('--overlap <n>', 'characters each split window repeats from the one before (needs --max-chars)', toInt, 0)
  .option('--force', 'replace an existing output', false)
  .option('--model <model>', `adds vectors with a standard model: ${STANDARD_MODELS.map((m) => m.id).join(' | ')} (install it with moca-embed models add)`)
  .option('--models <folder>', 'where the standard models are installed (default MOCA_MODELS, else ~/.moca/models)')
  .option('--embedder <module>', 'experimental: a module whose default export is an embedder { name, version?, dimensions, embed(texts) }; adds vectors')
  .action((pkg, opts) => run(async () => {
    if (opts.model && opts.embedder) throw new IndexError('use --model or --embedder, not both');
    let embedder;
    try {
      embedder = opts.model
        ? await standardEmbedder(opts.model, opts.models ?? defaultModelStore())
        : opts.embedder ? (await import(pathToFileURL(resolve(opts.embedder)).href)).default : undefined;
    } catch (err) {
      throw new IndexError(err.message);
    }
    if (Boolean(opts.out) === Boolean(opts.envelope)) throw new IndexError('pass -o <path> or --envelope <file>');
    if (opts.envelope) {
      let recipients;
      let passphrase;
      try {
        recipients = [...opts.recipient, ...readRecipients(opts.recipientsFile)];
        passphrase = opts.passphraseEnv ? passphraseFromEnv(opts.passphraseEnv) : undefined;
      } catch (err) {
        throw new IndexError(err.message);
      }
      const r = await addEnvelopeIndex({
        pkg, envelope: opts.envelope, recipients, passphrase, workFactor: opts.workFactor,
        chunker: opts.chunk, maxChars: opts.maxChars, overlap: opts.overlap, force: opts.force, embedder,
      });
      for (const w of r.warnings) console.error(`moca-index: warning: ${w}`);
      console.log(`Added index.age to ${r.envelope} (${r.items} item(s)) bound to ${r.digest}`);
      return;
    }
    const r = await buildSidecar({ pkg, out: opts.out, zip: opts.zip || /\.mocai$/i.test(opts.out ?? ''), chunker: opts.chunk, maxChars: opts.maxChars, overlap: opts.overlap, force: opts.force, embedder });
    console.log(`Wrote ${r.out} (${r.items} item(s)) bound to ${r.digest}`);
  }));

program.command('check')
  .argument('<sidecar>', 'sidecar folder or .mocai archive')
  .requiredOption('--package <path>', 'the package the sidecar should be bound to')
  .action((sidecar, opts) => run(async () => {
    const pkg = await readPackage(opts.package);
    if (!pkg.valid) throw new IndexError('the package is not valid; lint it first');
    const r = bindSidecar(sidecar, pkg);
    console.log(formatText(r.diagnostics));
    console.log(r.usable ? `\nUsable: ${r.chunks.length} chunk(s)` : '\nNot usable: a Reader will ignore this sidecar.');
    process.exitCode = r.usable ? 0 : 1;
  }));

function toInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new InvalidArgumentError('not a whole number');
  return n;
}

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof IndexError) {
      console.error(`moca-index: ${err.message}`);
      process.exit(2);
    }
    console.error(`moca-index: failed: ${err?.message ?? err}`);
    if (process.env.MOCA_INDEX_DEBUG) console.error(err?.stack);
    process.exit(1);
  }
}

program.parseAsync(process.argv);
