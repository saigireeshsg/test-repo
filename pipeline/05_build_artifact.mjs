// Step 5 - Build a self-contained copy of the web app for hosts that only let a page fetch its own
// files (e.g. a claude.ai artifact). Writes dist/artifact/:
//
//   * the page (web/*) with config.js switched to bundle mode and generator 'claude'
//   * bundle/minilm/   all-MiniLM-L6-v2 int8 (gzip + base64, split into <=12 MB text chunks) + tokenizer
//   * bundle/ort/      ONNX Runtime Web .wasm (gzip + base64)
//   * data/embeddings_q8.json  verse/passage/theme vectors re-embedded with the SAME int8 model, so the
//                              in-page query vectors and the index come from one model
//
// Run: MODEL_DIR=/path/to/models ORT_WASM=/path/to/ort-wasm-simd-threaded.asyncify.wasm node pipeline/05_build_artifact.mjs
//   MODEL_DIR/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx must exist (int8, e.g. onnxruntime quantize_dynamic).
//   ORT_WASM must be the build that the pinned transformers.js release expects (onnxruntime-web 1.31.0-dev.20260914).
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'artifact');
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const { MODEL_DIR, ORT_WASM } = process.env;
if (!MODEL_DIR || !ORT_WASM) throw new Error('set MODEL_DIR and ORT_WASM');
const MD = join(MODEL_DIR, MODEL_ID);
const CHUNK = 12 * 1024 * 1024;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'bundle', 'minilm'), { recursive: true });
mkdirSync(join(OUT, 'bundle', 'ort'), { recursive: true });
mkdirSync(join(OUT, 'data'), { recursive: true });
for (const f of ['index.html', 'style.css', 'app.js', 'worker.js', 'retrieval.js']) cpSync(join(ROOT, 'web', f), join(OUT, f));
for (const f of ['gita_index.json', 'dimensions.json']) cpSync(join(ROOT, 'web', 'data', f), join(OUT, 'data', f));

function chunked(buf, dir, stem) {
  const b64 = gzipSync(buf, { level: 9 }).toString('base64');
  const chunks = [];
  for (let i = 0; i * CHUNK < b64.length; i++) {
    const rel = `bundle/${dir}/${stem}.${i}.txt`;
    writeFileSync(join(OUT, rel), b64.slice(i * CHUNK, (i + 1) * CHUNK));
    chunks.push(rel);
  }
  return { gzip: true, chunks, bytes: buf.length };
}

// ---- model + runtime
const files = {};
for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) {
  cpSync(join(MD, f), join(OUT, 'bundle', 'minilm', f));
  files[f] = `bundle/minilm/${f}`;
}
files['onnx/model_quantized.onnx'] = chunked(readFileSync(join(MD, 'onnx', 'model_quantized.onnx')), 'minilm', 'model_quantized');
const ortWasm = chunked(readFileSync(ORT_WASM), 'ort', 'ort-wasm');

// ---- index re-embedded with the int8 model
env.localModelPath = MODEL_DIR.endsWith('/') ? MODEL_DIR : MODEL_DIR + '/';
env.allowRemoteModels = false;
const ix = JSON.parse(readFileSync(join(ROOT, 'web', 'data', 'gita_index.json'), 'utf8'));
const fe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' });
const DIM = 384;
async function embed(texts) {
  const out = new Float32Array(texts.length * DIM);
  for (let i = 0; i < texts.length; i += 32) out.set((await fe(texts.slice(i, i + 32), { pooling: 'mean', normalize: true })).data, i * DIM);
  return out;
}
const sec = Object.fromEntries(ix.sections.map((s) => [s.id, s]));
const ch = Object.fromEntries(ix.chapters.map((c) => [c.chapter, c]));
const VE = await embed(ix.verses.map((v) => `${sec[v.section_id].title} (${ch[v.chapter].name_english}): ${v.english}`));
const TI = await embed(ix.sections.map((s) => `${s.title}. ${ch[s.chapter].name_english}`));
const TE = await embed(ix.themes.map((t) => `${t.name}: ${t.description}`));
const SE = new Float32Array(ix.sections.length * DIM);
const norm = (a) => { let n = 0; for (const x of a) n += x * x; n = Math.sqrt(n) || 1; return a.map((x) => x / n); };
ix.sections.forEach((s, si) => {
  const kids = ix.verses.map((v, i) => [v, i]).filter(([v]) => v.section_id === s.id);
  let acc = new Float32Array(DIM);
  for (const [, i] of kids) for (let k = 0; k < DIM; k++) acc[k] += VE[i * DIM + k] / kids.length;
  acc = norm(acc);
  for (let k = 0; k < DIM; k++) acc[k] = 0.75 * acc[k] + 0.25 * TI[si * DIM + k];
  SE.set(norm(acc), si * DIM);
});
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
writeFileSync(join(OUT, 'data', 'embeddings_q8.json'), JSON.stringify({ dim: DIM, dtype: 'float32', model: `${MODEL_ID} int8`, verses: b64(VE), sections: b64(SE), themes: b64(TE) }));

// ---- config: bundle mode + Claude generation
let cfg = readFileSync(join(ROOT, 'web', 'config.js'), 'utf8');
cfg = cfg.replace("generator: 'cpu',", "generator: 'claude',")
  .replace('bundle: null,', `bundle: ${JSON.stringify({ modelId: MODEL_ID, embedDtype: 'q8', embeddings: 'embeddings_q8.json', files, ortWasm })},`);
if (!cfg.includes("generator: 'claude'") || cfg.includes('bundle: null')) throw new Error('config.js markers not found');
writeFileSync(join(OUT, 'config.js'), cfg);
console.log('wrote dist/artifact', { modelChunks: files['onnx/model_quantized.onnx'].chunks.length, ortChunks: ortWasm.chunks.length });
