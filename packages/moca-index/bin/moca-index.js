#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError } from 'commander';
import { readPackage, bindSidecar, formatText } from '@openmoca/moca-core';
import { buildSidecar, IndexError, CHUNKERS } from '../lib/index.js';
import { standardEmbedder, STANDARD_MODELS, defaultModelStore } from '@openmoca/moca-embed';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const program = new Command();
program.name('moca-index').description('Build and check moca-jsonl-v1 sidecar indexes.').version(version);

program.command('build')
  .argument('<package>', 'package directory or .moca archive')
  .requiredOption('-o, --out <path>', 'sidecar directory (or .zip with --zip); keep it outside the package')
  .option('--zip', 'write a single .zip archive', false)
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
    const r = await buildSidecar({ pkg, out: opts.out, zip: opts.zip, chunker: opts.chunk, maxChars: opts.maxChars, overlap: opts.overlap, force: opts.force, embedder });
    console.log(`Wrote ${r.out} (${r.items} item(s)) bound to ${r.digest}`);
  }));

program.command('check')
  .argument('<sidecar>', 'sidecar directory or .zip')
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
    throw err;
  }
}

program.parseAsync(process.argv);
