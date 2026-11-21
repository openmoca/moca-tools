// moca-lint --vocabulary: how a package's tags and structure concepts line up with a SKOS vocabulary (moca-spec
// #7). Informative only: LINT_ codes, never Reader rules. Readers ignore skos:exactMatch and skos:closeMatch (package
// spec §5.6); only this tool reads them. Nothing is fetched: the vocabulary is a local file.
import { readFileSync } from 'node:fs';
import { Parser } from 'n3';
import { readPackage } from '@openmoca/moca-core';

const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/** Package spec §2: case-insensitive means A-Z and a-z only. */
const fold = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function parseTurtle(text, baseIRI) {
  return new Parser({ format: 'text/turtle', baseIRI }).parse(text);
}

/**
 * Loads a vocabulary: a SKOS concept scheme in Turtle, or a .moca package whose structure.ttl holds one.
 * @param {string} file
 * @returns {Promise<{ concepts: Set<string>, labels: { iri: string, text: string, language: string }[] }>}
 */
export async function loadVocabulary(file) {
  let text;
  if (/\.moca$/i.test(file)) {
    const result = await readPackage(file);
    const entry = result.source?.list().find((e) => e.path === 'structure.ttl');
    if (!result.manifest || !entry) throw new Error(`${file} has no structure.ttl to use as a vocabulary`);
    text = Buffer.from(result.source.read(entry.path)).toString('utf8');
  } else {
    text = readFileSync(file, 'utf8');
  }
  const quads = parseTurtle(text, 'urn:moca-lint:vocabulary:');
  const concepts = new Set();
  const labels = [];
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && q.object.value === `${SKOS}Concept`) concepts.add(q.subject.value);
  }
  for (const q of quads) {
    if (!concepts.has(q.subject.value) || q.object.termType !== 'Literal') continue;
    if (q.predicate.value === `${SKOS}prefLabel` || q.predicate.value === `${SKOS}altLabel`) {
      labels.push({ iri: q.subject.value, text: q.object.value, language: q.object.language ?? '' });
    }
  }
  if (concepts.size === 0) throw new Error(`${file} declares no skos:Concept`);
  return { concepts, labels };
}

/** A label in `labelLanguage` serves a tag in `tagLanguage`: equal, or one a prefix of the other (en, en-GB). Either unknown matches. */
function sameLanguage(tagLanguage, labelLanguage) {
  if (!tagLanguage || !labelLanguage) return true;
  const a = fold(tagLanguage);
  const b = fold(labelLanguage);
  return a === b || a.startsWith(`${b}-`) || b.startsWith(`${a}-`);
}

function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

function nearest(text, labels) {
  let best = null;
  for (const l of labels) {
    const d = distance(fold(text), fold(l.text));
    if (!best || d < best.d) best = { d, label: l };
  }
  return best ? `; nearest: "${best.label.text}"${best.label.language ? `@${best.label.language}` : ''} (${best.label.iri})` : '';
}

/** Every tag the package uses, with its language and where it is. */
function tagsOf(result) {
  const language = typeof result.manifest?.language === 'string' ? result.manifest.language : '';
  const out = (result.tags ?? []).map((tag) => ({ tag, language, where: 'tags', file: 'moca.json' }));
  for (const [locale, t] of Object.entries(result.translations ?? {})) {
    for (const tag of t.tags ?? []) out.push({ tag, language: locale, where: `translations.${locale}.tags`, file: 'moca.json' });
  }
  for (const node of result.nodes ?? []) {
    for (const rep of node.representations) {
      const tags = Array.isArray(rep.frontmatter.tags) ? rep.frontmatter.tags.filter((t) => typeof t === 'string') : [];
      for (const tag of tags) out.push({ tag, language: rep.locale ?? language, where: 'tags', file: rep.file });
    }
  }
  return out;
}

/** The package's structure concepts and their skos:exactMatch and skos:closeMatch targets. */
function structureConcepts(result) {
  const entry = result.source?.list().find((e) => e.path === 'structure.ttl');
  if (!entry) return [];
  let quads;
  try {
    quads = parseTurtle(Buffer.from(result.source.read(entry.path)).toString('utf8'), 'urn:moca-lint:package:');
  } catch {
    return [];
  }
  const concepts = new Map();
  for (const q of quads) {
    if (q.predicate.value === RDF_TYPE && q.object.value === `${SKOS}Concept`) concepts.set(q.subject.value, []);
  }
  for (const q of quads) {
    if (concepts.has(q.subject.value) && (q.predicate.value === `${SKOS}exactMatch` || q.predicate.value === `${SKOS}closeMatch`)) {
      concepts.get(q.subject.value).push(q.object.value);
    }
  }
  return [...concepts].map(([iri, matches]) => ({ iri, matches }));
}

/**
 * Checks a valid package result against a vocabulary.
 * @param {object} result  a package result
 * @param {{ concepts: Set<string>, labels: object[] }} vocabulary  from loadVocabulary
 * @param {boolean} [strict]  warnings become errors
 */
export function vocabularyDiagnostics(result, vocabulary, strict = false) {
  if (!result.valid) return [];
  const out = [];
  for (const { tag, language, where, file } of tagsOf(result)) {
    const hit = vocabulary.concepts.has(tag) ? { iri: tag, how: 'its IRI' }
      : vocabulary.labels.filter((l) => fold(l.text) === fold(tag) && sameLanguage(language, l.language)).map((l) => ({ iri: l.iri, how: `the label "${l.text}"${l.language ? `@${l.language}` : ''}` }))[0];
    if (hit) out.push({ code: 'LINT_VOCABULARY_MATCH', severity: 'info', message: `${where} "${tag}" matches ${hit.iri} by ${hit.how}`, file });
    else out.push({ code: 'LINT_VOCABULARY_UNMATCHED', severity: 'info', message: `${where} "${tag}" matches no concept in the vocabulary${nearest(tag, vocabulary.labels.filter((l) => sameLanguage(language, l.language)))}`, file });
  }
  for (const { iri, matches } of structureConcepts(result)) {
    const via = vocabulary.concepts.has(iri) ? iri : matches.find((m) => vocabulary.concepts.has(m));
    if (via) {
      out.push({ code: 'LINT_VOCABULARY_MATCH', severity: 'info', message: via === iri ? `concept ${iri} is in the vocabulary` : `concept ${iri} matches ${via} through skos:exactMatch or skos:closeMatch`, file: 'structure.ttl' });
      continue;
    }
    const labels = result.structure?.graph?.concepts.get(iri)?.labels ?? {};
    const label = labels[''] ?? labels.en ?? Object.values(labels)[0];
    out.push({
      code: 'LINT_VOCABULARY_UNMATCHED',
      severity: strict ? 'error' : 'warning',
      message: `concept ${iri} is not in the vocabulary and has no skos:exactMatch or skos:closeMatch to it${nearest(typeof label === 'string' ? label : iri.replace(/^.*[#/]/, ''), vocabulary.labels)}`,
      file: 'structure.ttl',
    });
  }
  return out;
}
