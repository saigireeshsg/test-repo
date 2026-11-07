// Model worker: everything here runs on the CPU (ONNX Runtime WebAssembly backend).
//  - embedder: all-MiniLM-L6-v2 (same model and pooling used to build the index)
//  - generator: a small instruct LLM; a LogitsProcessor "probe" records the full next-token
//    distribution at every decoding step so the UI can show how each token was chosen.
let T = null;            // transformers.js module
let embedder = null;
let llm = null;          // { id, tokenizer, model }
let stopper = null;

const post = (type, data = {}) => self.postMessage({ type, ...data });

// ---- bundle mode (published artifact): model files and the ONNX Runtime .wasm ship inside the page
// as gzip+base64 text chunks, because the artifact host only lets the page fetch its own files.
async function loadChunks(spec, base) {
  const parts = await Promise.all(spec.chunks.map((u) => fetch(new URL(u, base)).then((r) => { if (!r.ok) throw new Error(`bundle ${u}: ${r.status}`); return r.text(); })));
  const b64 = parts.join('');
  const bin = atob(b64); const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  if (!spec.gzip) return u8.buffer;
  return new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}
function installBundleFetch(bundle, base) {
  const orig = T.env.fetch;
  const cache = new Map();
  const get = (name) => {
    if (!cache.has(name)) {
      const spec = bundle.files[name];
      cache.set(name, typeof spec === 'string' ? fetch(new URL(spec, base)).then((r) => r.arrayBuffer()) : loadChunks(spec, base));
    }
    return cache.get(name);
  };
  const prefix = bundle.modelId + '/';
  T.env.fetch = async (url, opts) => {
    const u = String(url);
    const at = u.indexOf(prefix);
    if (at >= 0) {
      const name = u.slice(at + prefix.length).replace(/^resolve\/[^/]+\//, '');
      if (!(name in bundle.files)) return new Response('not bundled', { status: 404 });
      const buf = await get(name);
      return new Response(buf, { status: 200, headers: { 'content-length': String(buf.byteLength), 'content-type': name.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
    }
    return orig(url, opts);
  };
}

async function init({ transformersUrl, modelHost, wasmPaths, bundle, base }) {
  if (T) return;
  T = await import(transformersUrl);
  T.env.allowLocalModels = false;
  if (bundle) {
    installBundleFetch(bundle, base);
    post('log', { msg: 'bundle mode: loading ONNX Runtime wasm from the page' });
    T.env.backends.onnx.wasm.wasmBinary = await loadChunks(bundle.ortWasm, base);
  }
  if (modelHost) {
    // self-hosted mirror laid out as <host>/<org>/<model>/<file> instead of the Hugging Face Hub
    T.env.remoteHost = modelHost.endsWith('/') ? modelHost : modelHost + '/';
    T.env.remotePathTemplate = '{model}/';
  }
  if (wasmPaths) T.env.backends.onnx.wasm.wasmPaths = wasmPaths;
  // multi-threaded WASM needs cross-origin isolation (SharedArrayBuffer); otherwise one thread.
  const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  T.env.backends.onnx.wasm.numThreads = threads;
  post('env', { threads, crossOriginIsolated: !!self.crossOriginIsolated, cores: navigator.hardwareConcurrency || 1 });
}

const progressCb = (which) => (p) => {
  if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate') {
    post('progress', { which, file: p.file, status: p.status, loaded: p.loaded, total: p.total, progress: p.progress });
  }
};

async function loadEmbedder(modelId, dtype = 'fp32') {
  const t0 = performance.now();
  embedder = await T.pipeline('feature-extraction', modelId, { device: 'wasm', dtype, progress_callback: progressCb('embedder') });
  post('ready', { which: 'embedder', ms: performance.now() - t0 });
}

async function embed(text) {
  const tok = embedder.tokenizer;
  const ids = Array.from(tok.encode(text));
  const pieces = tok.tokenize(text);
  // [CLS] pieces... [SEP]
  const tokens = ids.length === pieces.length + 2 ? ['[CLS]', ...pieces, '[SEP]'] : ids.map((id) => tok.decode([id]));
  const t0 = performance.now();
  // keep the per-token vectors too, so the UI can show mean pooling at work
  const raw = await embedder(text, { pooling: 'none', normalize: false });
  const [, n, d] = raw.dims;
  const tokenVecs = [];
  for (let i = 0; i < n; i++) tokenVecs.push(Array.from(raw.data.subarray(i * d, (i + 1) * d)));
  const pooled = await embedder(text, { pooling: 'mean', normalize: true });
  post('embedding', { ids, tokens, vector: Array.from(pooled.data), tokenVecs, ms: performance.now() - t0 });
}

async function loadLLM({ modelId, dtypes }) {
  if (llm?.id === modelId) return post('ready', { which: 'llm', ms: 0, modelId, dtype: llm.dtype });
  llm = null;
  const t0 = performance.now();
  const tokenizer = await T.AutoTokenizer.from_pretrained(modelId, { progress_callback: progressCb('llm') });
  let model = null, used = null, lastErr = null;
  for (const dtype of dtypes) {
    try {
      model = await T.AutoModelForCausalLM.from_pretrained(modelId, { device: 'wasm', dtype, progress_callback: progressCb('llm') });
      used = dtype;
      break;
    } catch (e) { lastErr = e; post('log', { msg: `dtype ${dtype} unavailable for ${modelId}: ${e.message}` }); }
  }
  if (!model) throw lastErr;
  llm = { id: modelId, tokenizer, model, dtype: used };
  post('ready', { which: 'llm', ms: performance.now() - t0, modelId, dtype: used });
}

function softmaxTopK(logits, k) {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  let z = 0;
  for (let i = 0; i < logits.length; i++) if (logits[i] !== -Infinity) z += Math.exp(logits[i] - max);
  // entropy over the full vocabulary (bits)
  let H = 0;
  // partial selection of the top-k
  const top = [];
  for (let i = 0; i < logits.length; i++) {
    const l = logits[i];
    if (l === -Infinity) continue;
    const p = Math.exp(l - max) / z;
    if (p > 1e-12) H -= p * Math.log2(p);
    if (top.length < k) { top.push([i, l]); if (top.length === k) top.sort((a, b) => b[1] - a[1]); }
    else if (l > top[k - 1][1]) {
      let j = k - 1;
      while (j > 0 && top[j - 1][1] < l) { top[j] = top[j - 1]; j--; }
      top[j] = [i, l];
    }
  }
  top.sort((a, b) => b[1] - a[1]);
  return { top: top.map(([id, l]) => ({ id, logit: l, p: Math.exp(l - max) / z })), entropy: H };
}

async function generate({ messages, maxNewTokens, temperature, topK }) {
  const { tokenizer, model } = llm;
  const prompt = tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true });
  const inputs = tokenizer(prompt);
  const promptIds = Array.from(inputs.input_ids.data, Number);
  // show the model's own view of the prompt: its tokens
  post('prompt_tokens', {
    count: promptIds.length,
    tokens: promptIds.map((id) => ({ id, text: tokenizer.decode([id]) })),
  });

  const steps = [];
  const t0 = performance.now();
  let tFirst = null;
  const decode1 = (id) => tokenizer.decode([id], { skip_special_tokens: false });

  class Probe extends T.LogitsProcessor {
    _call(input_ids, logits) {
      const now = performance.now();
      const ids = input_ids[0];
      const genSoFar = ids.length - promptIds.length;
      // the token chosen at the previous step is now the last input id
      if (genSoFar > 0 && steps[genSoFar - 1] && steps[genSoFar - 1].chosen == null) finishStep(genSoFar - 1, Number(ids[ids.length - 1]), now);
      if (tFirst === null) tFirst = now;
      const row = logits.dims.length === 2 ? logits[0].data : logits.data;
      const { top, entropy } = softmaxTopK(row, topK);
      const step = { step: genSoFar, t: now - t0, entropy, top: top.map((c) => ({ ...c, text: decode1(c.id) })), chosen: null };
      steps[genSoFar] = step;
      return logits;
    }
  }
  let lastT = performance.now();
  function finishStep(i, chosenId, now) {
    const s = steps[i];
    s.chosen = chosenId;
    s.chosenText = decode1(chosenId);
    const inTop = s.top.find((c) => c.id === chosenId);
    s.chosenP = inTop ? inTop.p : null;
    s.rank = inTop ? s.top.indexOf(inTop) + 1 : null;
    s.ms = now - lastT; lastT = now;
    post('step', { s });
  }

  stopper = new T.InterruptableStoppingCriteria();
  const lp = new T.LogitsProcessorList();
  lp.push(new Probe());
  const sampling = temperature > 0;
  post('gen_start', { prefillTokens: promptIds.length });
  const out = await model.generate({
    ...inputs,
    max_new_tokens: maxNewTokens,
    do_sample: sampling,
    temperature: sampling ? temperature : undefined,
    top_k: sampling ? 40 : undefined,
    repetition_penalty: 1.1,
    logits_processor: lp,
    stopping_criteria: stopper,
  });
  const seq = Array.from(out.data ?? out[0].data ?? [], Number);
  const end = performance.now();
  const last = steps.length - 1;
  if (last >= 0 && steps[last].chosen == null && seq.length > promptIds.length + last) finishStep(last, seq[promptIds.length + last], end);
  const genIds = seq.slice(promptIds.length);
  post('gen_done', {
    text: tokenizer.decode(genIds, { skip_special_tokens: true }),
    newTokens: genIds.length,
    prefillMs: tFirst !== null ? tFirst - t0 : 0,
    totalMs: end - t0,
  });
}

self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case 'init': await init(data); post('inited'); break;
      case 'load-embedder': await loadEmbedder(data.modelId, data.dtype); break;
      case 'embed': await embed(data.text); break;
      case 'load-llm': await loadLLM(data); break;
      case 'generate': await generate(data); break;
      case 'stop': stopper?.interrupt(); break;
    }
  } catch (e) {
    post('error', { where: data.type, message: e?.message || String(e), stack: e?.stack });
  }
};
