# @openmoca/moca-index

Builds [sidecar indexes](https://github.com/openmoca/moca-spec/blob/main/spec/moca-sidecar-index-spec.md) in the portable
`moca-jsonl-v1` format, bound to a package's digest.

```sh
moca-index build <package> -o <out> [--zip] [--chunk node|headings] [--max-chars n [--overlap n]] [--force] [--model name [--models folder]] [--embedder module]
moca-index check <sidecar> --package <package>
```

- `--chunk node` indexes each node representation whole; `--chunk headings`
  splits at level 1-3 headings. Every chunk records UTF-8 byte offsets into its
  node file.
- `--max-chars <n>` then splits any chunk longer than `n` characters, in its
  second half at the best break: a blank line, a line end, a sentence end or a
  space. `--overlap <n>` starts each window `n` characters before the last one
  ended, at a word boundary (at most half of `--max-chars`). Use it with an
  embedder: a model reads only so many tokens (about 4 characters each in
  English), and ignores the rest of a longer chunk. `index.json` records the
  limit in `chunking`.
- The builder checks its own output with the Reader before finishing.
- Keep sidecars outside the package directory.

- `--model` adds vectors with one of MOCA's standard embedding models:
  `bge-small-en-v1.5`, `nomic-embed-text-v1.5`, `all-MiniLM-L6-v2` or
  `multilingual-e5-small`. The index is then searched by meaning, as well as by
  words, by any tool that runs the same model, such as the MOCA MCP server.
  The model's files are read from a store folder (`--models`, else
  `MOCA_MODELS`, else `~/.moca/models`) and checked against their pinned
  SHA-256; install them with `npx @openmoca/moca-embed models add <model>`
  (or `moca-mcp models add`). The models are run by
  [`@openmoca/moca-embed`](../moca-embed#readme).
- `--embedder` (experimental) loads a module whose default export is an
  embedder (`name`, `version?`, `dimensions`, `queryPrefix?`,
  `documentPrefix?`, `embed(texts, { role })`). Chunks are embedded with the
  role `document`, and any declared prefixes are recorded in `model` for
  Readers to compare. The vectors go
  in `payload/vectors.f32` (little-endian float32, one row per item), and
  `index.json` records the embedder as its `model` (`indexType: hybrid`). A
  Reader searches the vectors only with an embedder for the same model.

Without `--embedder`, the sidecar is lexical: text and offsets, no vectors.
