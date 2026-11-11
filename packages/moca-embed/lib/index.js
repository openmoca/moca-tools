// @openmoca/moca-embed: MOCA's standard embedding models (sidecar index specification §5.1), local ONNX files pinned
// by Hugging Face commit and SHA-256, each with the convention every tool embeds it by. moca-index builds indexes with
// them, a TypeScript Reader searches with them, and the MCP server and the .NET and Python Readers run the same files
// the same way, so the vectors match everywhere.
//
// The model files live in a store folder, one sub-folder per model (default ~/.moca/models, or MOCA_MODELS). Loading
// never downloads: a missing or changed file is an error. addModel() downloads, and only when asked
// (`moca-embed models add`, or `moca-mcp models add`).
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ONNX = 'onnx/model_quantized.onnx';

/** The standard models: id, recorded name and version, size, tokens, pooling, prefixes, pinned files. */
export const STANDARD_MODELS = Object.freeze([
  {
    id: 'bge-small-en-v1.5', name: 'BAAI/bge-small-en-v1.5', version: 'onnx-q8', dimensions: 384, pooling: 'cls', maxTokens: 512,
    queryPrefix: 'Represent this sentence for searching relevant passages: ', documentPrefix: '',
    repository: 'Xenova/bge-small-en-v1.5', commit: 'ea104dacec62c0de699686887e3f920caeb4f3e3', licence: 'MIT',
    files: {
      'vocab.txt': '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
      'config.json': 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
      'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
      [ONNX]: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
    },
  },
  {
    id: 'nomic-embed-text-v1.5', name: 'nomic-ai/nomic-embed-text-v1.5', version: 'onnx-q8', dimensions: 768, pooling: 'mean', maxTokens: 2048,
    queryPrefix: 'search_query: ', documentPrefix: 'search_document: ',
    repository: 'nomic-ai/nomic-embed-text-v1.5', commit: 'e9b6763023c676ca8431644204f50c2b100d9aab', licence: 'Apache-2.0',
    files: {
      'vocab.txt': '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
      'config.json': '9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b',
      'tokenizer.json': 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      'tokenizer_config.json': 'd7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc',
      'special_tokens_map.json': '5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a',
      [ONNX]: 'b4342336debaea79de872370664b0aaeb67dea4605513d00ee236ea871a81f27',
    },
  },
  {
    id: 'all-MiniLM-L6-v2', name: 'sentence-transformers/all-MiniLM-L6-v2', version: 'onnx-q8', dimensions: 384, pooling: 'mean', maxTokens: 256,
    queryPrefix: '', documentPrefix: '',
    repository: 'Xenova/all-MiniLM-L6-v2', commit: '751bff37182d3f1213fa05d7196b954e230abad9', licence: 'Apache-2.0',
    files: {
      'vocab.txt': '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
      'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
      'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
      'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      'special_tokens_map.json': 'b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3',
      [ONNX]: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
    },
  },
  {
    id: 'multilingual-e5-small', name: 'intfloat/multilingual-e5-small', version: 'onnx-q8', dimensions: 384, pooling: 'mean', maxTokens: 512,
    queryPrefix: 'query: ', documentPrefix: 'passage: ',
    repository: 'Xenova/multilingual-e5-small', commit: '761b726dd34fb83930e26aab4e9ac3899aa1fa78', licence: 'MIT',
    files: {
      'sentencepiece.bpe.model': 'cfc8146abe2a0488e9e2a0c56de7952f7c11ab059eca145a0a727afce0db2865',
      'config.json': 'cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1',
      'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
      'tokenizer_config.json': 'a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b',
      'special_tokens_map.json': 'd05497f1da52c5e09554c0cd874037a083e1dc1b9cfd48034d1c717f1afc07a7',
      [ONNX]: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    },
  },
]);

/** The default model store: MOCA_MODELS, else ~/.moca/models. */
export const defaultModelStore = () => process.env.MOCA_MODELS || join(homedir(), '.moca', 'models');

/** A standard model by id or recorded name, or undefined. */
export function findStandardModel(idOrName) {
  return STANDARD_MODELS.find((m) => m.id.toLowerCase() === String(idOrName).toLowerCase() || m.name === idOrName);
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * An embedder for a standard model from a store, in moca-index's shape: name, version, dimensions, prefixes,
 * embed(texts, { role }). Each file is checked against its pinned SHA-256 first. It needs the optional dependency
 * @huggingface/transformers, which runs the ONNX file and the model's own tokenizer.
 *
 * Its convention, shared with moca-mcp: the role's prefix; tokens cut as Hugging Face's Python tokenizer cuts them
 * (the start token, the first maxTokens - 2 tokens, the end token); one text per run (the 8-bit models quantise
 * activations per run); CLS or mean pooling; L2-normalised.
 */
export async function standardEmbedder(idOrName, store = defaultModelStore()) {
  const model = findStandardModel(idOrName);
  if (!model) throw new Error(`not a standard model: ${idOrName} (${STANDARD_MODELS.map((m) => m.id).join(', ')})`);
  const folder = join(store, model.id);
  for (const [file, expected] of Object.entries(model.files)) {
    const path = join(folder, file);
    if (!existsSync(path)) throw new Error(`${model.id} is not installed in ${store}: run moca-embed models add ${model.id}`);
    if ((await sha256(path)) !== expected) throw new Error(`${model.id}: ${file} does not match its pinned SHA-256`);
  }

  let transformers;
  try {
    transformers = await import('@huggingface/transformers');
  } catch {
    throw new Error('the standard models need @huggingface/transformers: npm install @huggingface/transformers');
  }
  const { AutoTokenizer, AutoModel, Tensor, env } = transformers;
  env.allowRemoteModels = false;
  env.localModelPath = store.endsWith('/') ? store : `${store}/`;
  const tokenizer = await AutoTokenizer.from_pretrained(model.id);
  const net = await AutoModel.from_pretrained(model.id, { dtype: 'q8', device: 'cpu' });
  const tensor = (values) => new Tensor('int64', BigInt64Array.from(values.map(BigInt)), [1, values.length]);

  async function embedOne(text) {
    const all = Array.from(tokenizer(text).input_ids.data, Number);
    const ids = all.length <= model.maxTokens ? all : [...all.slice(0, model.maxTokens - 1), all[all.length - 1]];
    const { last_hidden_state: hidden } = await net({ input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)), token_type_ids: tensor(ids.map(() => 0)) });
    const [, length, dims] = hidden.dims;
    const v = new Array(dims).fill(0);
    if (model.pooling === 'cls') {
      for (let d = 0; d < dims; d++) v[d] = hidden.data[d];
    } else {
      for (let t = 0; t < length; t++) for (let d = 0; d < dims; d++) v[d] += hidden.data[t * dims + d];
      for (let d = 0; d < dims; d++) v[d] /= length;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }

  return {
    name: model.name,
    version: model.version,
    dimensions: model.dimensions,
    queryPrefix: model.queryPrefix,
    documentPrefix: model.documentPrefix,
    async embed(texts, { role = 'document' } = {}) {
      const prefix = role === 'query' ? model.queryPrefix : model.documentPrefix;
      const out = [];
      for (const text of texts) out.push(await embedOne(prefix + text));
      return out;
    },
  };
}

/** The standard models whose files are all present in a store (not yet checked). */
export function installedModels(store = defaultModelStore()) {
  return STANDARD_MODELS.filter((m) => Object.keys(m.files).every((f) => existsSync(join(store, m.id, f))));
}

/**
 * Downloads a standard model's files from Hugging Face at its pinned commit into a store, checking each SHA-256
 * before anything is installed; a file that does not match is discarded with the rest.
 */
export async function addModel(idOrName, store = defaultModelStore(), progress = () => {}) {
  const model = findStandardModel(idOrName);
  if (!model) throw new Error(`not a standard model: ${idOrName} (${STANDARD_MODELS.map((m) => m.id).join(', ')})`);
  const staging = join(store, `.${model.id}.partial`);
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const [file, expected] of Object.entries(model.files)) {
      progress(`downloading ${model.id}/${file}`);
      const res = await fetch(`https://huggingface.co/${model.repository}/resolve/${model.commit}/${file}`, { headers: { 'user-agent': 'moca-embed' } });
      if (!res.ok || !res.body) throw new Error(`${model.id}: ${file}: HTTP ${res.status}`);
      const path = join(staging, file);
      mkdirSync(dirname(path), { recursive: true });
      await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
      if ((await sha256(path)) !== expected) throw new Error(`${model.id}: ${file} from Hugging Face does not match its pinned SHA-256; nothing was installed`);
    }
    rmSync(join(store, model.id), { recursive: true, force: true });
    renameSync(staging, join(store, model.id));
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
  return model;
}
