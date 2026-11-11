# @openmoca/moca-embed

MOCA's four standard embedding models, run locally, for semantic and hybrid
search over MOCA packages. An index built with one of them, and a question
embedded with the same one, match whichever tool did each: `moca-index`, a
MOCA Reader, or the MOCA MCP server.

| Model | Size | Best for |
| --- | --- | --- |
| `bge-small-en-v1.5` | 33 MB | English, a good default |
| `all-MiniLM-L6-v2` | 22 MB | English, the smallest and fastest |
| `nomic-embed-text-v1.5` | 131 MB | English, long pages |
| `multilingual-e5-small` | 117 MB | Many languages |

## Install a model

```sh
npx @openmoca/moca-embed models add bge-small-en-v1.5
npx @openmoca/moca-embed models list
```

Models go in a store folder: `~/.moca/models`, or `MOCA_MODELS`, or
`--models <folder>`. `models add` is the only command that downloads: the
files you name, from Hugging Face at a pinned commit, each checked against
its pinned SHA-256 before it is installed.

## Search with a TypeScript Reader

```js
import { Library, Search, LexicalBackend, DenseBackend, HybridBackend, readPackage, bindSidecar } from '@openmoca/moca-core';
import { standardEmbedder } from '@openmoca/moca-embed';

const pkg = await readPackage('acme-support.moca', { trustRoot: 'trust-root.json' });
const sidecar = bindSidecar('acme-support.moca.idx', pkg);
const library = new Library().add(pkg, sidecar);

// The same model the index was built with; its files are checked before loading.
const embedder = await standardEmbedder('bge-small-en-v1.5');
const backend = new HybridBackend({ lexical: new LexicalBackend(library), dense: new DenseBackend(library, { embedder }) });
const results = await new Search(library, { backend, audiences: ['public'] }).search('money back after buying');
```

Build the index with the same model: `npx @openmoca/moca-index build acme-support.moca -o acme-support.moca.idx --chunk headings --model bge-small-en-v1.5`.

## How each model is run

The convention is part of MOCA's sidecar index specification (§5.1), so every
tool agrees: the role's prefix, the model's own tokenizer cut as Hugging
Face's Python tokenizer cuts, one text per run, then the model's pooling and
unit length. `standardEmbedder()` returns an embedder in the Reader's shape:
`name`, `version` (`onnx-q8`), `dimensions`, `queryPrefix`, `documentPrefix`
and `embed(texts, { role })`.

## Licence

Apache-2.0. Each model has its own licence: MIT (bge-small, multilingual-e5)
or Apache-2.0 (all-MiniLM, nomic-embed).
