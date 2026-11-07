// Step 2 - Index, chunk, embed and project.
//
//   data/verses.json + data/taxonomy.json
//     -> child chunks   (700 shlokas)
//     -> parent chunks  (78 thematic sections)
//     -> embeddings     (all-MiniLM-L6-v2, 384-d, mean-pooled, L2-normalised; same model the browser uses)
//     -> theme index    (primary theme from the curated section + embedding similarity to every theme)
//     -> 3-D layouts    (PCA, exactly reproducible for queries; UMAP for neighbourhood structure)
//
// Output: web/data/{gita_index.json, verse_embeddings.f32, section_embeddings.f32, theme_embeddings.f32}
//
// Run:  MODEL_DIR=/path/to/models node pipeline/02_build_index.mjs
//       (MODEL_DIR must contain Xenova/all-MiniLM-L6-v2/{config.json,tokenizer.json,tokenizer_config.json,onnx/model.onnx};
//        omit it to download from the Hugging Face Hub)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import { UMAP } from 'umap-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'data');
mkdirSync(OUT, { recursive: true });

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
if (process.env.MODEL_DIR) {
  env.localModelPath = process.env.MODEL_DIR.endsWith('/') ? process.env.MODEL_DIR : process.env.MODEL_DIR + '/';
  env.allowRemoteModels = false;
}

const verses = JSON.parse(readFileSync(join(ROOT, 'data', 'verses.json'), 'utf8'));
const tax = JSON.parse(readFileSync(join(ROOT, 'data', 'taxonomy.json'), 'utf8'));
const DIM = 384;

// ------------------------------------------------------------------ chunking
const sections = tax.sections.map((s, i) => ({
  id: `S${String(i + 1).padStart(2, '0')}`,
  ...s,
  label: `BG ${s.chapter}.${s.start}-${s.end}`,
}));
const sectionOf = (c, v) => sections.find((s) => s.chapter === c && v >= s.start && v <= s.end);
const chapterMeta = Object.fromEntries(tax.chapters.map((c) => [c.chapter, c]));

const children = verses.map((v, i) => {
  const s = sectionOf(v.chapter, v.verse);
  return {
    idx: i,
    id: v.id,
    chapter: v.chapter,
    verse: v.verse,
    speaker: v.speaker,
    section_id: s.id,
    hexad: chapterMeta[v.chapter].hexad,
    sanskrit_iast: v.sanskrit_iast,
    sanskrit_devanagari: v.sanskrit_devanagari,
    english: v.english,
    alignment: v.alignment,
    // text that is embedded for the child chunk: a contextual header (section + chapter) + the verse.
    // The header lifts retrieval for modern-English questions over Ganguli's archaic prose.
    embed_text: `${s.title} (${chapterMeta[v.chapter].name_english}): ${v.english}`,
  };
});
for (const s of sections) {
  s.verse_ids = children.filter((c) => c.section_id === s.id).map((c) => c.id);
  s.text = children.filter((c) => c.section_id === s.id).map((c) => `[${c.id}] ${c.english}`).join(' ');
}

// ------------------------------------------------------------------ embedding
console.time('embed');
const extractor = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });
async function embedAll(texts, bs = 32) {
  const out = new Float32Array(texts.length * DIM);
  for (let i = 0; i < texts.length; i += bs) {
    const t = await extractor(texts.slice(i, i + bs), { pooling: 'mean', normalize: true });
    out.set(t.data, i * DIM);
    process.stdout.write(`\r  embedded ${Math.min(i + bs, texts.length)}/${texts.length}`);
  }
  process.stdout.write('\n');
  return out;
}
const row = (M, i) => M.subarray(i * DIM, (i + 1) * DIM);
const dot = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };
const normalize = (a) => { const n = Math.sqrt(dot(a, a)) || 1; for (let k = 0; k < a.length; k++) a[k] /= n; return a; };

const childE = await embedAll(children.map((c) => c.embed_text));
const titleE = await embedAll(sections.map((s) => `${s.title}. ${tax.chapters[s.chapter - 1].name_english}`));
const themeE = await embedAll(tax.themes.map((t) => `${t.name}: ${t.description}`));
console.timeEnd('embed');

// parent vector = centroid of its children blended with its title vector
const sectionE = new Float32Array(sections.length * DIM);
sections.forEach((s, si) => {
  const acc = new Float32Array(DIM);
  const kids = children.filter((c) => c.section_id === s.id);
  for (const c of kids) { const r = row(childE, c.idx); for (let k = 0; k < DIM; k++) acc[k] += r[k] / kids.length; }
  normalize(acc);
  const t = row(titleE, si);
  for (let k = 0; k < DIM; k++) acc[k] = 0.75 * acc[k] + 0.25 * t[k];
  sectionE.set(normalize(acc), si * DIM);
});

// ------------------------------------------------------------------ theme index
const themeIds = tax.themes.map((t) => t.id);
for (const c of children) {
  const sims = themeIds.map((id, ti) => ({ id, score: dot(row(childE, c.idx), row(themeE, ti)) }));
  sims.sort((a, b) => b.score - a.score);
  const sec = sections.find((s) => s.id === c.section_id);
  c.primary_theme = sec.themes[0];
  // curated section themes first, then up to two extra themes the embedding strongly agrees with
  const extra = sims.filter((s) => !sec.themes.includes(s.id) && s.score >= sims[0].score - 0.03 && s.score > 0.28).slice(0, 2);
  c.themes = [...sec.themes, ...extra.map((e) => e.id)];
  c.theme_scores = Object.fromEntries(sims.slice(0, 5).map((s) => [s.id, +s.score.toFixed(3)]));
}

// ------------------------------------------------------------------ 3-D projections
function pca(M, n, k = 3) {
  const mean = new Float32Array(DIM);
  for (let i = 0; i < n; i++) for (let d = 0; d < DIM; d++) mean[d] += M[i * DIM + d] / n;
  const X = new Float64Array(n * DIM);
  for (let i = 0; i < n; i++) for (let d = 0; d < DIM; d++) X[i * DIM + d] = M[i * DIM + d] - mean[d];
  const comps = [];
  const variances = [];
  let total = 0;
  for (let i = 0; i < n * DIM; i++) total += X[i] * X[i];
  for (let c = 0; c < k; c++) {
    let v = new Float64Array(DIM).map((_, d) => Math.sin(d * 12.9898 + c * 78.233));
    for (let it = 0; it < 200; it++) {
      const Xv = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let d = 0; d < DIM; d++) s += X[i * DIM + d] * v[d]; Xv[i] = s; }
      const w = new Float64Array(DIM);
      for (let i = 0; i < n; i++) for (let d = 0; d < DIM; d++) w[d] += X[i * DIM + d] * Xv[i];
      for (const p of comps) { const pr = w.reduce((s, x, d) => s + x * p[d], 0); for (let d = 0; d < DIM; d++) w[d] -= pr * p[d]; }
      const nn = Math.sqrt(w.reduce((s, x) => s + x * x, 0));
      v = w.map((x) => x / nn);
    }
    let varc = 0;
    for (let i = 0; i < n; i++) { let s = 0; for (let d = 0; d < DIM; d++) s += X[i * DIM + d] * v[d]; varc += s * s; }
    comps.push(Array.from(v));
    variances.push(varc / total);
  }
  return { mean: Array.from(mean), components: comps, explained_variance_ratio: variances };
}
const P = pca(childE, children.length);
const project = (vec) => P.components.map((c) => c.reduce((s, x, d) => s + x * (vec[d] - P.mean[d]), 0));
children.forEach((c) => (c.pca = project(row(childE, c.idx)).map((x) => +x.toFixed(4))));
sections.forEach((s, si) => (s.pca = project(row(sectionE, si)).map((x) => +x.toFixed(4))));
console.log('PCA explained variance (3 comps):', P.explained_variance_ratio.map((x) => x.toFixed(3)).join(', '));

// seeded RNG so the UMAP layout is reproducible
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const umap = new UMAP({ nComponents: 3, nNeighbors: 15, minDist: 0.15, distanceFn: (a, b) => 1 - dot(a, b), random: rand });
const data = children.map((c) => Array.from(row(childE, c.idx)));
console.time('umap');
const Y = umap.fit(data);
console.timeEnd('umap');
children.forEach((c, i) => (c.umap = Y[i].map((x) => +x.toFixed(4))));
sections.forEach((s) => {
  const kids = children.filter((c) => c.section_id === s.id);
  s.umap = [0, 1, 2].map((k) => +(kids.reduce((a, c) => a + c.umap[k], 0) / kids.length).toFixed(4));
});

// ------------------------------------------------------------------ write
writeFileSync(join(OUT, 'verse_embeddings.f32'), Buffer.from(childE.buffer));
writeFileSync(join(OUT, 'section_embeddings.f32'), Buffer.from(sectionE.buffer));
writeFileSync(join(OUT, 'theme_embeddings.f32'), Buffer.from(themeE.buffer));
const index = {
  model: MODEL_ID,
  dim: DIM,
  source: 'English: K. M. Ganguli (1883-96), public domain. Sanskrit: standard 700-verse text. Taxonomy: this project.',
  hexads: tax.hexads,
  themes: tax.themes,
  chapters: tax.chapters.map((c) => ({ ...c, verse_count: children.filter((v) => v.chapter === c.chapter).length })),
  pca: P,
  sections: sections.map(({ text, ...s }) => ({ ...s, text })),
  verses: children.map(({ embed_text, idx, ...c }) => c),
};
writeFileSync(join(OUT, 'gita_index.json'), JSON.stringify(index));
console.log(`wrote ${children.length} child chunks, ${sections.length} parent chunks, ${tax.themes.length} themes -> web/data/`);

// quick retrieval sanity check
const q = await extractor(['What should I do when I am afraid of failing?'], { pooling: 'mean', normalize: true });
const top = children.map((c) => ({ id: c.id, s: dot(q.data, row(childE, c.idx)) })).sort((a, b) => b.s - a.s).slice(0, 5);
console.log('sanity query top-5:', top.map((t) => `${t.id} (${t.s.toFixed(3)})`).join(', '));
