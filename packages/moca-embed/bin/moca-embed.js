#!/usr/bin/env node
// moca-embed models list | add <model...> [--models folder]: the standard embedding models in a model store. `add` is
// the only command that downloads: the files you name, from Hugging Face at their pinned commit, checked before
// they are installed.
import { Command } from 'commander';
import { STANDARD_MODELS, addModel, defaultModelStore, installedModels } from '../lib/index.js';

const program = new Command();
program.name('moca-embed').description("MOCA's standard embedding models.");
const models = program.command('models').description('list or add standard models in a model store');

models.command('list')
  .option('--models <folder>', 'the model store (default MOCA_MODELS, else ~/.moca/models)')
  .action((opts) => {
    const store = opts.models ?? defaultModelStore();
    const installed = new Set(installedModels(store).map((m) => m.id));
    console.log(`Standard models (store: ${store}):`);
    for (const m of STANDARD_MODELS) console.log(`  ${installed.has(m.id) ? 'installed' : '         '}  ${m.id.padEnd(24)} ${m.name} (${m.dimensions} dimensions, ${m.licence})`);
  });

models.command('add')
  .argument('<model...>', `standard models: ${STANDARD_MODELS.map((m) => m.id).join(', ')}`)
  .option('--models <folder>', 'the model store (default MOCA_MODELS, else ~/.moca/models)')
  .action(async (names, opts) => {
    const store = opts.models ?? defaultModelStore();
    try {
      for (const name of names) {
        const m = await addModel(name, store, (line) => console.error(`moca-embed: ${line}`));
        console.error(`moca-embed: installed ${m.id} in ${store} (checked)`);
      }
    } catch (err) {
      console.error(`moca-embed: ${err.message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
