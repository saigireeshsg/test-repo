import { CONFIG } from './config.js';
import { GitaIndex, supabaseParentChild, buildContext, buildMessages } from './retrieval.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 3) => (x == null ? '—' : Number(x).toFixed(d));
const ms = (x) => (x < 1000 ? `${x.toFixed(0)} ms` : `${(x / 1000).toFixed(2)} s`);
const store = {
  get(k, d) { try { const v = localStorage.getItem('gita-rag:' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gita-rag:' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const EXAMPLES = [
  'Should I care about the results of my work?',
  'How do I control anger and desire?',
  'Is the soul immortal? What happens at death?',
  'How should I meditate?',
  'Why does Krishna take birth on earth?',
  'What kind of food is good to eat?',
  'What are the qualities of a true devotee?',
];

// ------------------------------------------------------------------ palettes
const THEME_COLORS = ['#7c6f64', '#b91c1c', '#7c3aed', '#0369a1', '#c2410c', '#0f766e', '#be185d', '#a16207', '#2563eb', '#059669',
  '#db2777', '#9333ea', '#dc2626', '#475569', '#65a30d', '#0891b2', '#e11d48', '#ca8a04', '#4f46e5'];
const HEXAD_COLORS = { karma: '#c2410c', bhakti: '#be185d', jnana: '#2563eb' };
const SPEAKER_COLORS = { Krishna: '#2563eb', Arjuna: '#c2410c', Sanjaya: '#059669', Dhritarashtra: '#7c3aed' };
const chapterColor = (c) => `hsl(${((c - 1) * 360) / 18}, 65%, 50%)`;

// ------------------------------------------------------------------ state
const S = { dims: null, index: null, worker: null, embedReady: false, llmReady: null, busy: false, run: null, selStep: null };

// ------------------------------------------------------------------ worker plumbing
const listeners = new Set();
function startWorker() {
  S.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  S.worker.onmessage = ({ data }) => { for (const l of [...listeners]) l(data); };
  S.worker.onerror = (e) => setStatus(`worker error: ${e.message}`);
  S.worker.postMessage({
    type: 'init', transformersUrl: CONFIG.transformersUrl, modelHost: CONFIG.modelHost, wasmPaths: CONFIG.wasmPaths,
  });
}
function waitFor(pred) {
  return new Promise((resolve, reject) => {
    const l = (m) => {
      if (m.type === 'error') { listeners.delete(l); reject(new Error(`${m.where}: ${m.message}`)); return; }
      if (pred(m)) { listeners.delete(l); resolve(m); }
    };
    listeners.add(l);
  });
}
listeners.add((m) => {
  if (m.type === 'env') $('#pill-cpu').textContent = `CPU · WASM · ${m.threads} thread${m.threads > 1 ? 's' : ''} / ${m.cores} cores`;
  if (m.type === 'progress') onProgress(m);
  if (m.type === 'log') console.info('[worker]', m.msg);
});
const prog = { embedder: {}, llm: {} };
function onProgress(m) {
  const p = prog[m.which]; if (!p || !m.file) return;
  if (m.total) p[m.file] = { loaded: m.loaded, total: m.total };
  const vals = Object.values(p); const L = vals.reduce((a, b) => a + b.loaded, 0), T = vals.reduce((a, b) => a + b.total, 0);
  const pct = T ? (100 * L) / T : 0;
  const pill = m.which === 'llm' ? $('#pill-llm') : $('#pill-embed');
  if (!(m.which === 'llm' ? S.llmReady : S.embedReady)) {
    pill.className = 'pill busy';
    pill.textContent = `${m.which === 'llm' ? 'LLM' : 'embedder'}: downloading ${pct.toFixed(0)}% (${(T / 1e6).toFixed(0)} MB)`;
    const bar = document.querySelector(`#prog-${m.which} div`); if (bar) bar.style.width = pct + '%';
  }
}
async function ensureEmbedder() {
  if (S.embedReady) return;
  const p = $('#pill-embed'); p.className = 'pill busy'; p.textContent = 'embedder: loading';
  S.worker.postMessage({ type: 'load-embedder', modelId: CONFIG.embedModel });
  const r = await waitFor((m) => m.type === 'ready' && m.which === 'embedder');
  S.embedReady = true; p.className = 'pill ok'; p.textContent = `embedder: MiniLM-L6 · ${ms(r.ms)}`;
}
async function ensureLLM() {
  const id = $('#llm').value;
  if (S.llmReady === id) return;
  const spec = CONFIG.llms.find((l) => l.id === id);
  const p = $('#pill-llm'); p.className = 'pill busy'; p.textContent = 'LLM: loading'; S.llmReady = null; prog.llm = {};
  S.worker.postMessage({ type: 'load-llm', modelId: id, dtypes: spec.dtypes });
  const r = await waitFor((m) => m.type === 'ready' && m.which === 'llm');
  S.llmReady = id; p.className = 'pill ok'; p.textContent = `LLM: ${id.split('/')[1]} · ${r.dtype}`;
}

// ------------------------------------------------------------------ stage helpers
function stage(name, state, time) {
  const el = document.querySelector(`.stage[data-stage="${name}"]`);
  el.classList.remove('active', 'done'); if (state) el.classList.add(state);
  if (time !== undefined) el.querySelector('.t').textContent = time;
}
function resetStages() {
  document.querySelectorAll('.stage').forEach((el) => { el.classList.remove('active', 'done'); el.querySelector('.t').textContent = ''; });
  ['#s-tokenize', '#s-embed', '#s-search', '#s-parent', '#s-prompt'].forEach((s) => ($(s).innerHTML = ''));
  $('#answer').innerHTML = ''; $('#gen-stats').textContent = '';
}
const setStatus = (t) => ($('#ask-status').textContent = t);

// heatmap of vectors: rows = vectors, cols = 384 dims, diverging colour
function heatmap(rows, { height = 10 } = {}) {
  const c = document.createElement('canvas');
  const D = rows[0].length; c.width = D; c.height = rows.length * height; c.className = 'heat' + (rows.length > 1 ? ' tall' : '');
  const g = c.getContext('2d');
  rows.forEach((r, ri) => {
    const m = Math.max(...r.map(Math.abs)) || 1;
    r.forEach((x, d) => {
      const v = x / m; const a = Math.min(1, Math.abs(v) * 1.2);
      g.fillStyle = v >= 0 ? `rgba(194,65,12,${a})` : `rgba(67,56,202,${a})`;
      g.fillRect(d, ri * height, 1, height);
    });
  });
  return c;
}

// ------------------------------------------------------------------ main flow
async function ask() {
  if (S.busy) return;
  const question = $('#q').value.trim(); if (!question) return;
  S.busy = true; $('#ask').disabled = true; $('#stop').disabled = false;
  resetStages(); S.selStep = null;
  const run = (S.run = { question, steps: [], t0: performance.now() });
  try {
    // 1-2. tokenise + embed
    stage('tokenize', 'active'); setStatus('loading embedding model…');
    await ensureEmbedder();
    setStatus('embedding…');
    S.worker.postMessage({ type: 'embed', text: question });
    const e = await waitFor((m) => m.type === 'embedding');
    run.vector = new Float32Array(e.vector);
    run.tokens = e.tokens;
    run.tokenVecs = e.tokenVecs.map((v) => { const n = Math.hypot(...v) || 1; return Float32Array.from(v, (x) => x / n); });
    renderTokens(e); stage('tokenize', 'done', `${e.ids.length} tokens`);
    renderEmbedding(e); stage('embed', 'done', ms(e.ms));

    // 3-4. retrieval
    stage('search', 'active'); setStatus('searching…');
    const k = +$('#k').value, pk = +$('#pk').value, backend = $('#backend').value;
    const t1 = performance.now();
    let R;
    if (backend === 'supabase') {
      const cfg = { url: $('#sb-url').value.trim(), anonKey: $('#sb-key').value.trim() };
      if (!cfg.url || !cfg.anonKey) throw new Error('Supabase URL and anon key are not set (Settings), or switch the vector store to in-browser.');
      R = await supabaseParentChild(cfg, run.vector, k, pk);
    } else {
      R = S.index.localParentChild(run.vector, k, pk);
    }
    run.retrieval = R;
    const tSearch = performance.now() - t1;
    renderHits(R); stage('search', 'done', `${ms(tSearch)} · ${backend === 'supabase' ? 'pgvector' : 'browser'}`);
    renderParents(R); stage('parent', 'done', `${R.top.length} passages`);
    updateSpace();

    // 5. prompt
    const mode = $('#mode').value;
    const ctx = buildContext(S.index, R, { mode, budget: +$('#budget').value });
    run.ctx = ctx;
    const messages = buildMessages(question, ctx);
    renderPrompt(ctx, messages, mode); stage('prompt', 'active');
    updateSpace();

    // 6. generate
    stage('generate', 'active', 'loading model…'); setStatus('loading LLM (first time downloads the weights)…');
    $('#gen-stats').innerHTML = '<div class="progress" id="prog-llm"><div></div></div>';
    await ensureLLM();
    setStatus('prefill: the model is reading the prompt…');
    const sendGen = () => S.worker.postMessage({
      type: 'generate', messages, maxNewTokens: +$('#maxnew').value, temperature: +$('#temp').value, topK: 10,
    });
    const onMsg = (m) => {
      if (m.type === 'prompt_tokens') { renderPromptTokens(m); stage('prompt', 'done', `${m.count} LLM tokens`); }
      if (m.type === 'step') onStep(m.s);
    };
    listeners.add(onMsg);
    sendGen();
    const done = await waitFor((m) => m.type === 'gen_done').finally(() => listeners.delete(onMsg));
    const decodeMs = done.totalMs - done.prefillMs;
    stage('generate', 'done', `${done.newTokens} tokens · ${ms(done.totalMs)}`);
    $('#gen-stats').textContent = `prefill ${ms(done.prefillMs)} (${run.promptTokens} prompt tokens, ${(run.promptTokens / (done.prefillMs / 1000)).toFixed(0)} tok/s) · decode ${(done.newTokens / Math.max(decodeMs / 1000, 1e-3)).toFixed(1)} tok/s on CPU · mean chosen-token p = ${fmt(run.steps.reduce((a, s) => a + (s.chosenP || 0), 0) / Math.max(1, run.steps.length), 2)}`;
    linkCitations();
    setStatus(`done in ${ms(performance.now() - run.t0)}`);
  } catch (err) {
    console.error(err);
    setStatus('');
    const cur = document.querySelector('.stage.active .body') || $('#s-generate');
    cur.insertAdjacentHTML('beforeend', `<div class="err">${esc(err.message)}</div>`);
  } finally {
    S.busy = false; $('#ask').disabled = false; $('#stop').disabled = true;
  }
}

// ------------------------------------------------------------------ renderers: stages 1-5
function renderTokens(e) {
  $('#s-tokenize').innerHTML = `<div class="toks">${e.tokens.map((t, i) =>
    `<span class="tok ${/^\[.*\]$/.test(t) ? 'special' : ''}">${esc(t)}<small>${e.ids[i]}</small></span>`).join('')}</div>`;
}
function renderEmbedding(e) {
  const el = $('#s-embed'); el.innerHTML = '';
  const lab = (t) => Object.assign(document.createElement('div'), { className: 'muted small', textContent: t });
  el.append(lab(`per-token vectors from the last layer (${e.tokenVecs.length} × 384):`), heatmap(e.tokenVecs, { height: 6 }));
  el.append(lab('mean-pooled + normalised query vector (384 dims; saffron +, indigo −):'), heatmap([e.vector], { height: 34 }));
  const tm = tokenMeaning(e.tokens, e.tokenVecs);
  el.insertAdjacentHTML('beforeend', `<div class="muted small" style="margin-top:8px">what each token vector points to (before pooling):</div>
    <div class="tokmap">${tm.map((t) => `<span class="tk">${esc(t.token)}</span><span>${esc(t.theme)} · nearest <span class="vchip" data-v="${t.verse}">${t.verse}</span></span><span class="score">${fmt(t.sim)}</span>`).join('')}</div>`);
  const th = S.index.themeScores(new Float32Array(e.vector)).slice(0, 5);
  const max = th[0].score;
  el.insertAdjacentHTML('beforeend', `<div class="muted small" style="margin-top:8px">closest themes (cosine to theme descriptions):</div>
    <div class="hits">${th.map((t) => `<div class="hit theme"><span class="id">${esc(t.name)}</span><div class="bar alt" style="width:${(100 * t.score) / max}%"></div><span class="score">${fmt(t.score)}</span></div>`).join('')}</div>`);
}
function renderHits(R) {
  const max = R.hits[0]?.similarity || 1;
  $('#s-search').innerHTML = `<div class="hits">${R.hits.map((h) => {
    const v = S.index.byId.get(h.id);
    return `<div class="hit" data-v="${esc(h.id)}"><span class="id">${esc(h.id)}</span><div><div class="bar" style="width:${(100 * h.similarity) / max}%"></div><div class="txt">${esc(v.english)}</div></div><span class="score">${fmt(h.similarity)}</span></div>`;
  }).join('')}</div>`;
}
function renderParents(R) {
  const topIds = new Set(R.top.map((p) => p.section_id));
  $('#s-parent').innerHTML = R.allParents.slice(0, 6).map((p) => {
    const s = S.index.sectionById.get(p.section_id);
    const density = 0.15 * (Math.log(1 + p.child_hits) / Math.log(1 + +$('#k').value));
    return `<div class="parent ${topIds.has(p.section_id) ? 'best' : ''}" data-sec="${s.id}">
      <h4>${topIds.has(p.section_id) ? '✓ ' : ''}${esc(s.label)} · ${esc(s.title)} <span class="muted small">score ${fmt(p.score)}</span></h4>
      <div class="breakdown">
        <span>best child ${fmt(p.best_child_similarity)}</span><div class="bar" style="width:${100 * 0.6 * p.best_child_similarity / 0.6}%"></div><span>${fmt(0.6 * p.best_child_similarity)}</span>
        <span>passage vec ${fmt(p.parent_similarity)}</span><div class="bar alt" style="width:${100 * p.parent_similarity}%"></div><span>${fmt(0.25 * p.parent_similarity)}</span>
        <span>density ${p.child_hits} hit${p.child_hits > 1 ? 's' : ''}</span><div class="bar" style="width:${100 * density / 0.15}%;opacity:.5"></div><span>${fmt(density)}</span>
      </div>
      <div class="vchips">${s.verse_ids.map((id) => `<span class="vchip ${p.matched_verse_ids.includes(id) ? 'on' : ''}" data-v="${esc(id)}">${id.replace('BG ', '')}</span>`).join('')}</div>
    </div>`;
  }).join('');
}
function renderPrompt(ctx, messages, mode) {
  const inCtx = new Set(ctx.blocks.flatMap((b) => b.verses));
  document.querySelectorAll('#s-parent .vchip').forEach((c) => c.classList.toggle('ctx', inCtx.has(c.dataset.v)));
  $('#s-prompt').innerHTML = `<div class="muted small">${mode === 'parent' ? 'parent-child' : 'child-only'} context: ${ctx.blocks.length} block(s), ≈${ctx.used} / ${$('#budget').value} tokens budget
      ${ctx.blocks.some((b) => b.windowed) ? ' · long passages windowed to matched verses ± 1 neighbour' : ''}</div>
    <pre class="prompt">${esc(messages.map((m) => `<|${m.role}|>\n${m.content}`).join('\n\n'))}</pre>
    <div id="llm-toks" class="muted small"></div>`;
}
function renderPromptTokens(m) {
  S.run.promptTokens = m.count;
  const shown = m.tokens.slice(-60);
  $('#llm-toks').innerHTML = `LLM tokenizer: <b>${m.count}</b> tokens. Last 60 (where generation continues):
    <div class="toks" style="margin-top:4px">${shown.map((t) => `<span class="tok">${esc(t.text.replace(/\n/g, '⏎')) || '·'}<small>${t.id}</small></span>`).join('')}</div>`;
  setStatus('generating…');
  $('#gen-stats').textContent = 'reading prompt (prefill)…';
}

// ------------------------------------------------------------------ stage 6: tokens
function probColor(p) {
  // high probability = calm green, low = hot red
  const h = 120 * Math.max(0, Math.min(1, p ?? 0));
  return `hsla(${h}, 75%, 45%, 0.28)`;
}
function onStep(s) {
  const run = S.run; run.steps[s.step] = s;
  const span = document.createElement('span');
  span.className = 'gt'; span.dataset.step = s.step; span.textContent = s.chosenText;
  span.style.background = probColor(s.chosenP);
  span.title = `step ${s.step} · p=${fmt(s.chosenP)} · rank ${s.rank ?? '>10'} · entropy ${fmt(s.entropy, 2)} bits`;
  if (/^<\|.*\|>$|^<\/?s>$/.test(s.chosenText.trim())) span.style.opacity = 0.4;
  $('#answer').append(span);
  $('#gen-stats').textContent = `token ${s.step + 1} · ${s.ms.toFixed(0)} ms/token`;
  stage('generate', 'active', `${s.step + 1} tokens`);
  if (S.selStep === null || S.selStep === s.step - 1) showStep(s.step, true);
  drawTimeline();
}
function showStep(i, follow = false) {
  const s = S.run?.steps[i]; if (!s) return;
  S.selStep = follow ? i : i;
  document.querySelectorAll('.gt.sel').forEach((e) => e.classList.remove('sel'));
  document.querySelector(`.gt[data-step="${i}"]`)?.classList.add('sel');
  const ctxText = S.run.steps.slice(Math.max(0, i - 8), i).map((x) => x.chosenText).join('');
  $('#nt-label').textContent = `step ${i} · after “…${ctxText.slice(-40)}” · entropy ${fmt(s.entropy, 2)} bits`;
  const top = [...s.top].reverse();
  const ink = css('--ink'), muted = css('--muted');
  Plotly.react('nexttok', [{
    type: 'bar', orientation: 'h', x: top.map((c) => c.p), y: top.map((c, j) => `${JSON.stringify(c.text).slice(1, -1)} ·${top.length - j}`),
    marker: { color: top.map((c) => (c.id === s.chosen ? css('--accent') : css('--accent-2'))) },
    text: top.map((c) => `${(100 * c.p).toFixed(1)}%  logit ${c.logit.toFixed(2)}`), textposition: 'auto',
    hovertemplate: '%{y}<br>p=%{x:.4f}<extra></extra>',
  }], {
    margin: { l: 110, r: 10, t: 6, b: 28 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: ink, size: 11, family: 'JetBrains Mono, monospace' }, xaxis: { range: [0, 1], title: { text: 'probability (after softmax)', font: { size: 10, color: muted } }, gridcolor: css('--line') },
    yaxis: { automargin: true },
  }, { displayModeBar: false, responsive: true });
}
function drawTimeline() {
  const st = S.run.steps.filter(Boolean);
  Plotly.react('timeline', [
    { x: st.map((s) => s.step), y: st.map((s) => s.chosenP), name: 'p(chosen)', mode: 'lines', line: { color: css('--accent') } },
    { x: st.map((s) => s.step), y: st.map((s) => s.entropy), name: 'entropy (bits)', yaxis: 'y2', mode: 'lines', line: { color: css('--accent-2'), dash: 'dot' } },
  ], {
    margin: { l: 36, r: 36, t: 4, b: 24 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', showlegend: true,
    legend: { orientation: 'h', y: 1.25, font: { size: 10 } }, font: { color: css('--ink'), size: 10 },
    xaxis: { title: { text: 'generation step', font: { size: 10 } }, gridcolor: css('--line') }, yaxis: { range: [0, 1], gridcolor: css('--line') },
    yaxis2: { overlaying: 'y', side: 'right', rangemode: 'tozero', showgrid: false },
  }, { displayModeBar: false, responsive: true });
}
function linkCitations() {
  // make [BG x.y] citations in the answer clickable
  const txt = $('#answer').textContent;
  const cites = [...new Set([...txt.matchAll(/BG\s?(\d{1,2})\.(\d{1,2})/g)].map((m) => `BG ${m[1]}.${m[2]}`))].filter((id) => S.index.byId.has(id));
  if (cites.length) $('#gen-stats').insertAdjacentHTML('beforeend', `<div style="margin-top:6px">cited: ${cites.map((c) => `<span class="vchip on" data-v="${c}">${c}</span>`).join(' ')}</div>`);
}

// ------------------------------------------------------------------ dimensions helpers
function projDims(q, k = 3) {
  const D = S.dims; const out = [];
  for (let c = 0; c < k; c++) { let s = 0; const comp = D.components[c]; for (let d = 0; d < comp.length; d++) s += comp[d] * (q[d] - D.mean[d]); out.push(s); }
  return out;
}
function tokenMeaning(tokens, vecs) {
  const ix = S.index;
  return tokens.map((token, i) => {
    const raw = vecs[i]; const n = Math.hypot(...raw) || 1; const q = Float32Array.from(raw, (x) => x / n);
    let best = -2, bi = 0;
    for (const v of ix.verses) { const s = ix.dotRow(ix.VE, v.idx, q); if (s > best) { best = s; bi = v.idx; } }
    const th = ix.themeScores(q)[0];
    return { token, verse: ix.verses[bi].id, sim: best, theme: th.name, q };
  });
}
// place an arbitrary vector in the UMAP layout: similarity-weighted centroid of its 5 nearest verses
function umapPlace(q) {
  const ix = S.index;
  const top = ix.verses.map((v) => [v, ix.dotRow(ix.VE, v.idx, q)]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const w = top.map(([, s]) => Math.max(1e-3, s) ** 4); const W = w.reduce((a, b) => a + b, 0);
  return [0, 1, 2].map((k) => top.reduce((s, [v], i) => s + w[i] * v.umap[k], 0) / W);
}

// ------------------------------------------------------------------ 3-D embedding space
function colorFor(v, by) {
  if (by === 'theme') return THEME_COLORS[S.index.themes.findIndex((t) => t.id === v.primary_theme)];
  if (by === 'chapter') return chapterColor(v.chapter);
  if (by === 'hexad') return HEXAD_COLORS[v.hexad];
  return SPEAKER_COLORS[v.speaker] || '#888';
}
function legend(by) {
  const ix = S.index;
  let items;
  if (by === 'theme') items = ix.themes.map((t, i) => [t.name, THEME_COLORS[i], ix.verses.filter((v) => v.primary_theme === t.id).length]);
  else if (by === 'chapter') items = ix.chapters.map((c) => [`${c.chapter}. ${c.name_english}`, chapterColor(c.chapter), c.verse_count]);
  else if (by === 'hexad') items = ix.hexads.map((h) => [h.title, HEXAD_COLORS[h.id]]);
  else items = Object.entries(SPEAKER_COLORS).map(([k, c]) => [k, c, ix.verses.filter((v) => v.speaker === k).length]);
  $('#legend').innerHTML = items.map(([n, c, cnt]) => `<span><i style="background:${c}"></i>${esc(n)}${cnt ? ` <span class="muted">(${cnt})</span>` : ''}</span>`).join('');
}
function updateSpace() {
  const ix = S.index; const lay = $('#layout').value; const by = $('#colorby').value;
  const P = (v) => v[lay];
  const run = S.run;
  const hitIds = new Set(run?.retrieval?.hits.map((h) => h.id) || []);
  const ctxIds = new Set(run?.ctx?.blocks.flatMap((b) => b.verses) || []);
  const topSecs = new Set(run?.retrieval?.top.map((p) => p.section_id) || []);
  const active = hitIds.size > 0;
  const traces = [{
    type: 'scatter3d', mode: 'markers', name: 'shlokas',
    x: ix.verses.map((v) => P(v)[0]), y: ix.verses.map((v) => P(v)[1]), z: ix.verses.map((v) => P(v)[2]),
    text: ix.verses.map((v) => `<b>${v.id}</b> · ${esc(v.speaker)} · ${v.primary_theme}<br>${esc(v.english.slice(0, 110))}…`),
    customdata: ix.verses.map((v) => v.id), hovertemplate: '%{text}<extra></extra>',
    marker: {
      size: ix.verses.map((v) => (hitIds.has(v.id) ? 7 : ctxIds.has(v.id) ? 4.5 : 3)),
      color: ix.verses.map((v) => colorFor(v, by)),
      opacity: 0.85,
    },
  }];
  if (active) {
    const hv = ix.verses.filter((v) => hitIds.has(v.id));
    traces.push({
      type: 'scatter3d', mode: 'markers', name: 'retrieved verses',
      x: hv.map((v) => P(v)[0]), y: hv.map((v) => P(v)[1]), z: hv.map((v) => P(v)[2]),
      customdata: hv.map((v) => v.id), text: hv.map((v) => `<b>${v.id}</b><br>${esc(v.english.slice(0, 110))}…`), hovertemplate: '%{text}<extra>hit</extra>',
      marker: { size: 9, color: 'rgba(0,0,0,0)', line: { width: 3, color: css('--accent') } },
    });
  }
  if ($('#show-parents').checked) {
    traces.push({
      type: 'scatter3d', mode: 'markers', name: 'passages (parents)',
      x: ix.sections.map((s) => P(s)[0]), y: ix.sections.map((s) => P(s)[1]), z: ix.sections.map((s) => P(s)[2]),
      text: ix.sections.map((s) => `<b>${s.label}</b><br>${esc(s.title)}`), hovertemplate: '%{text}<extra>passage</extra>',
      customdata: ix.sections.map((s) => 'sec:' + s.id),
      marker: { symbol: 'diamond', size: ix.sections.map((s) => (topSecs.has(s.id) ? 9 : 4)), color: ix.sections.map((s) => (topSecs.has(s.id) ? css('--accent') : 'rgba(128,128,128,.45)')), line: { width: 0 } },
    });
  }
  if (active && run.vector) {
    const q = lay === 'pca' ? projDims(run.vector) : ix.projectUMAP(run.retrieval.hits);
    const lx = [], ly = [], lz = [];
    for (const h of run.retrieval.hits) { const p = P(ix.byId.get(h.id)); lx.push(q[0], p[0], null); ly.push(q[1], p[1], null); lz.push(q[2], p[2], null); }
    traces.push({ type: 'scatter3d', mode: 'lines', name: 'query → hits', x: lx, y: ly, z: lz, line: { color: css('--accent'), width: 3 }, hoverinfo: 'skip', opacity: 0.6 });
    traces.push({ type: 'scatter3d', mode: 'markers+text', name: 'your question', x: [q[0]], y: [q[1]], z: [q[2]], text: ['Q'], textposition: 'top center',
      marker: { size: 10, color: css('--accent'), symbol: 'diamond-open', line: { width: 3, color: css('--accent') } }, hovertemplate: esc(run.question) + '<extra>query</extra>' });
    if ($('#show-tokens').checked && run.tokenVecs) {
      const tm = tokenMeaning(run.tokens, run.tokenVecs);
      const pts = tm.map((t) => (lay === 'pca' ? projDims(t.q) : umapPlace(t.q)));
      const special = run.tokens.map((t) => /^\[(CLS|SEP)\]$/.test(t));
      const lx = [], ly = [], lz = [];
      pts.forEach((p) => { lx.push(p[0], q[0], null); ly.push(p[1], q[1], null); lz.push(p[2], q[2], null); });
      traces.push({ type: 'scatter3d', mode: 'lines', name: 'tokens → question (mean pooling)', x: lx, y: ly, z: lz, line: { color: css('--accent-2'), width: 2, dash: 'dot' }, hoverinfo: 'skip' });
      traces.push({
        type: 'scatter3d', mode: 'markers+text', name: 'question tokens', x: pts.map((p) => p[0]), y: pts.map((p) => p[1]), z: pts.map((p) => p[2]),
        text: run.tokens, textposition: 'top center', textfont: { size: 12, color: css('--accent-2'), family: 'JetBrains Mono, monospace' },
        marker: { size: 5, color: special.map((sp) => (sp ? 'rgba(128,128,128,.6)' : css('--accent-2'))) },
        customdata: tm.map((t) => t.verse),
        hovertext: tm.map((t) => `token <b>${esc(t.token)}</b><br>points toward: ${esc(t.theme)}<br>nearest verse ${t.verse} (cos ${t.sim.toFixed(3)})`),
        hovertemplate: '%{hovertext}<extra>token</extra>',
      });
      // arrow heads: cones 75% of the way from each token to the question
      const span = Math.max(...[0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k]), q[k]) - Math.min(...pts.map((p) => p[k]), q[k]))) || 1;
      const dir = pts.map((p) => { const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]]; const n = Math.hypot(...d) || 1; return d.map((x) => x / n); });
      const mid = pts.map((p) => [0, 1, 2].map((k) => p[k] + 0.75 * (q[k] - p[k])));
      traces.push({ type: 'cone', name: 'pooling direction', x: mid.map((m) => m[0]), y: mid.map((m) => m[1]), z: mid.map((m) => m[2]),
        u: dir.map((d) => d[0]), v: dir.map((d) => d[1]), w: dir.map((d) => d[2]), anchor: 'center', sizemode: 'absolute', sizeref: span * 0.05,
        colorscale: [[0, css('--accent-2')], [1, css('--accent-2')]], showscale: false, hoverinfo: 'skip', showlegend: false });
    }
    const D = S.dims;
    $('#space-note').textContent = lay === 'pca'
      ? `PC1 ${(100 * D.explained_variance_ratio[0]).toFixed(0)}%: ${D.axes[0].label} · PC2: ${D.axes[1].label} · PC3: ${D.axes[2].label} — the question and its tokens are projected exactly`
      : 'query placed at the similarity-weighted centroid of its top-5 neighbours';
  } else {
    $('#space-note').textContent = lay === 'pca' ? `700 shlokas, 384-d → 3-D by PCA (these 3 axes hold ${(100 * S.dims.cumulative[2]).toFixed(0)}% of the variance; see the Dimensions tab) · PC1: ${S.dims.axes[0].label}` : '700 shlokas, 384-d → 3-D by UMAP (cosine, 15 neighbours)';
  }
  const ink = css('--ink'), grid = css('--line');
  const ax = (t) => ({ title: { text: t }, showspikes: false, gridcolor: grid, zerolinecolor: grid, color: css('--muted'), showticklabels: false });
  Plotly.react('space', traces, {
    margin: { l: 0, r: 0, t: 0, b: 0 }, paper_bgcolor: 'rgba(0,0,0,0)', showlegend: true,
    legend: { x: 0, y: 1, font: { size: 11, color: ink }, bgcolor: 'rgba(0,0,0,0)' }, font: { color: ink },
    scene: { xaxis: ax(lay === 'pca' ? 'PC1 ' + S.dims.axes[0].label.split('  ↔  ').map((x) => x.split(' (')[0]).join(' ↔ ') : 'U1'), yaxis: ax(lay === 'pca' ? 'PC2 ' + S.dims.axes[1].label.split('  ↔  ').map((x) => x.split(' (')[0]).join(' ↔ ') : 'U2'), zaxis: ax(lay === 'pca' ? 'PC3' : 'U3'), bgcolor: 'rgba(0,0,0,0)' },
    uirevision: lay,
  }, { displaylogo: false, responsive: true });
  legend(by);
}

// ------------------------------------------------------------------ verse detail + thematic index
function showVerse(id) {
  const v = S.index.byId.get(id); if (!v) return;
  const s = S.index.sectionById.get(v.section_id); const ch = S.index.chapters[v.chapter - 1];
  const themeName = (t) => S.index.themes.find((x) => x.id === t)?.name || t;
  const card = $('#verse-card'); card.hidden = false;
  card.innerHTML = `<div class="verse">
    <div class="row" style="margin:0"><h3 class="h">${v.id} · ${esc(v.speaker)}</h3><button class="ghost" id="vc-close">×</button></div>
    <div class="muted small">Chapter ${v.chapter}: ${esc(ch.name_sanskrit)} — ${esc(ch.name_english)} · passage ${esc(s.label)} “${esc(s.title)}” (parent ${s.id})</div>
    <p class="dev">${esc(v.sanskrit_devanagari)}</p>
    <p class="iast">${esc(v.sanskrit_iast)}</p>
    <p class="eng">${esc(v.english)}</p>
    <div class="tagrow">${v.themes.map((t) => `<span class="tag">${esc(themeName(t))}</span>`).join('')}</div>
    <div class="muted small" style="margin-top:6px">theme similarity: ${Object.entries(v.theme_scores).map(([k, x]) => `${k} ${x}`).join(' · ')}
    ${v.alignment === 'clause' ? '<br>Ganguli runs this verse and its neighbour into one sentence; the verse boundary is inside it.' : ''}</div>
  </div>`;
  $('#vc-close').onclick = () => (card.hidden = true);
  activateTab('space');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function renderIndex() {
  const ix = S.index;
  const themeIdx = Object.fromEntries(ix.themes.map((t, i) => [t.id, i]));
  $('#index-view').innerHTML = ix.hexads.map((h) => `<div class="hexad"><h3 style="color:${HEXAD_COLORS[h.id]}">${esc(h.title)}</h3>
    <p class="muted small">${esc(h.summary)}</p>
    ${ix.chapters.filter((c) => c.hexad === h.id).map((c) => {
      const secs = ix.sections.filter((s) => s.chapter === c.chapter);
      const vs = ix.verses.filter((v) => v.chapter === c.chapter);
      return `<details class="chap"><summary><b>${c.chapter}</b> <span>${esc(c.name_sanskrit)} — ${esc(c.name_english)}</span> <span class="muted small">${c.verse_count} verses · ${secs.length} passages</span></summary>
        <p class="small">${esc(c.summary)}</p>
        <div class="strip" title="each verse coloured by its primary theme">${vs.map((v) => `<div style="flex:1;background:${THEME_COLORS[themeIdx[v.primary_theme]]}" title="${v.id}: ${v.primary_theme}"></div>`).join('')}</div>
        <div class="secs">${secs.map((s) => `<div class="sec"><span class="lab">${s.id} · ${esc(s.label)}</span>${esc(s.title)}
          ${s.themes.map((t) => `<span class="tag" style="border-left:3px solid ${THEME_COLORS[themeIdx[t]]}">${esc(ix.themes[themeIdx[t]].name)}</span>`).join(' ')}
          <div class="vchips">${s.verse_ids.map((id) => `<span class="vchip" data-v="${id}">${id.replace('BG ', '')}</span>`).join('')}</div></div>`).join('')}</div>
      </details>`;
    }).join('')}</div>`).join('') + `<h3>Themes</h3><div class="hits">${ix.themes.map((t, i) => {
      const n = ix.verses.filter((v) => v.themes.includes(t.id)).length;
      return `<div class="hit" style="grid-template-columns: 220px 1fr 40px"><span><i style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${THEME_COLORS[i]}"></i> ${esc(t.name)}</span><div class="bar" style="width:${(100 * n) / 200}%;background:${THEME_COLORS[i]}"></div><span class="score">${n}</span></div>`;
    }).join('')}</div><p class="muted small">Counts include secondary themes. Primary theme comes from the curated passage; secondary themes are added where the verse embedding sits close to another theme's description.</p>`;
}
function renderAbout() {
  const ix = S.index;
  $('#about').innerHTML = `
  <h3>Data</h3>
  <p>All <b>700 shlokas</b> in the standard numbering, each with Devanagari, IAST transliteration and the public-domain English of <b>K. M. Ganguli</b> (Mahabharata, Bhishma Parva XXV–XLII, 1883–96). Ganguli wrote continuous prose, so his text was split into clauses and aligned to the Sanskrit verses by a dynamic programme using speaker markers, a Sanskrit→English cue lexicon (vocatives, names, key terms) and a syllable-length prior.</p>
  <h3>Index &amp; chunking</h3>
  <p>Three levels: <b>3 hexads</b> (karma, bhakti, jnana) → <b>18 chapters</b> → <b>${ix.sections.length} passages</b> (parent chunks, contiguous verse ranges with one teaching each) → <b>700 verses</b> (child chunks). Every verse has a primary theme from its passage plus up to two secondary themes from embedding similarity to <b>${ix.themes.length} theme</b> descriptions.</p>
  <h3>Embeddings &amp; vector store</h3>
  <p>Child chunks are embedded with <code>all-MiniLM-L6-v2</code> (384-d, mean-pooled, L2-normalised) with a contextual header (<i>passage title (chapter name): verse</i>), which helps modern-English questions match the archaic translation. Parent vectors are the centroid of their children blended 3:1 with the passage-title vector. The vectors live in <b>Supabase Postgres + pgvector</b> (HNSW, cosine) and in the browser; both run the same scoring.</p>
  <h3>Parent-child retrieval</h3>
  <p>Search the small chunks for precision (top-k verses), then return their <i>parents</i> for context: hits are grouped by passage and passages are ranked by <code>0.60·best child + 0.25·passage vector + 0.15·log-density of hits</code>. The top passages go into the prompt, whole if they fit the token budget, otherwise windowed to the matched verses ± 1 neighbour. Switch to <i>Child chunks only</i> in Settings to compare.</p>
  <h3>Generation on the CPU</h3>
  <p>A small instruct model runs in a Web Worker on ONNX Runtime WebAssembly (no GPU). A custom <code>LogitsProcessor</code> sees the final logits at every step; the page shows the softmax top-10, the chosen token and its rank, and the entropy of the whole distribution. <b>Prefill</b> (reading the prompt) dominates latency; each new token then costs one forward pass reusing the KV-cache.</p>
  <h3>The 3-D space</h3>
  <p>PCA is a linear map, so your question is projected exactly. UMAP preserves neighbourhoods better but has no exact transform here, so the question is placed at the similarity-weighted centroid of its nearest verses. Distances in 3-D are only an approximation of cosine distance in 384-d.</p>`;
}
function renderDims() {
  const D = S.dims;
  $('#dims-summary').innerHTML = `<h3 style="margin-top:0">How many dimensions does meaning need?</h3>
    <div><span class="stat"><b>${D.dim}</b>dimensions in each embedding</span><span class="stat"><b>≈${Math.round(D.participation_ratio)}</b>effectively used by the 700 verses</span>
    <span class="stat"><b>${D.components_for['50']}</b>for 50 % of the variation</span><span class="stat"><b>${D.components_for['90']}</b>for 90 %</span><span class="stat"><b>3</b>what a human can see: ${(100 * D.cumulative[2]).toFixed(0)} %</span></div>
    <p>The embedding model writes every text as ${D.dim} numbers, but the verses do not use all directions equally. The <b>participation ratio</b> (an effective-dimensionality measure) says the Gita's meaning-space behaves like about <b>${Math.round(D.participation_ratio)} independent dimensions</b>. People can only look at 3 at a time, so the 3-D plot is a shadow showing ${(100 * D.cumulative[2]).toFixed(0)} % of the structure. Use the parallel-coordinates plot below to see 10 dimensions at once (${(100 * D.cumulative[9]).toFixed(0)} %).</p>
    <p class="muted small">No single dimension of a learned embedding is human-meaningful on its own, but principal directions often are: each axis below is labelled by the themes and verses at its two poles.</p>`;
  const n = 80, xs = [...Array(n).keys()].map((i) => i + 1);
  Plotly.react('scree', [
    { type: 'bar', x: xs, y: D.explained_variance_ratio.slice(0, n), name: 'variance per dimension', marker: { color: css('--accent-2') } },
    { type: 'scatter', mode: 'lines', x: xs, y: D.cumulative.slice(0, n), name: 'cumulative', yaxis: 'y2', line: { color: css('--accent') } },
  ], {
    margin: { l: 40, r: 40, t: 6, b: 30 }, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: { color: css('--ink'), size: 11 },
    legend: { orientation: 'h', y: 1.15 }, xaxis: { title: { text: 'principal component' }, gridcolor: css('--line') },
    yaxis: { tickformat: '.0%', gridcolor: css('--line') }, yaxis2: { overlaying: 'y', side: 'right', range: [0, 1], tickformat: '.0%', showgrid: false },
    shapes: [3, D.components_for['50'], D.components_for['80']].map((x) => ({ type: 'line', x0: x + 0.5, x1: x + 0.5, y0: 0, y1: 1, yref: 'paper', line: { dash: 'dot', color: css('--muted'), width: 1 } })),
    annotations: [[3, '3-D view'], [D.components_for['50'], '50 %'], [D.components_for['80'], '80 %']].map(([x, t]) => ({ x: x + 0.5, y: 1, yref: 'paper', text: t, showarrow: false, yanchor: 'bottom', font: { size: 10, color: css('--muted') } })),
  }, { displayModeBar: false, responsive: true });
  $('#axes-table').innerHTML = `<table class="axes"><tr><th>axis</th><th>+ pole (themes · verses)</th><th>− pole (themes · verses)</th></tr>${D.axes.map((a) => `<tr><td class="pc">PC${a.pc}<br><span class="muted">${(100 * a.explained).toFixed(1)}%</span></td>
    <td>${a.positive_themes.map(esc).join(', ')}<div class="vchips">${a.positive_verses.map((id) => `<span class="vchip" data-v="${id}">${id.replace('BG ', '')}</span>`).join('')}</div></td>
    <td>${a.negative_themes.map(esc).join(', ')}<div class="vchips">${a.negative_verses.map((id) => `<span class="vchip" data-v="${id}">${id.replace('BG ', '')}</span>`).join('')}</div></td></tr>`).join('')}</table>`;
  drawParcoords();
}
function drawParcoords() {
  const D = S.dims, ix = S.index, k = D.k;
  const hexIdx = { karma: 0, bhakti: 1, jnana: 2 };
  const cols = ix.verses.map((v) => hexIdx[v.hexad]);
  const rows = ix.verses.map((v) => D.scores[v.idx]);
  if (S.run?.vector) { rows.push(projDims(S.run.vector, k)); cols.push(3); }
  const dims = [...Array(k).keys()].map((c) => {
    const vals = rows.map((r) => r[c]);
    const a = D.axes[c];
    return { label: `PC${c + 1}`, values: vals, range: [Math.min(...vals), Math.max(...vals)], tickvals: [Math.min(...vals), Math.max(...vals)], ticktext: [a.negative_themes[0].split(' (')[0].split(/[ ,;]/)[0].slice(0, 10) + ' −', a.positive_themes[0].split(' (')[0].split(/[ ,;]/)[0].slice(0, 10) + ' +'] };
  });
  Plotly.react('parcoords', [{
    type: 'parcoords', dimensions: dims,
    line: { color: cols, cmin: 0, cmax: 3, colorscale: [[0, HEXAD_COLORS.karma], [0.33, HEXAD_COLORS.karma], [0.34, HEXAD_COLORS.bhakti], [0.66, HEXAD_COLORS.bhakti], [0.67, HEXAD_COLORS.jnana], [0.99, HEXAD_COLORS.jnana], [1, css('--ink')]] },
    labelfont: { size: 11, color: css('--ink') }, tickfont: { size: 9, color: css('--muted') }, rangefont: { size: 1, color: 'rgba(0,0,0,0)' },
  }], { margin: { l: 60, r: 60, t: 40, b: 30 }, paper_bgcolor: 'rgba(0,0,0,0)', font: { color: css('--ink') } }, { displayModeBar: false, responsive: true });
}
function activateTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'space') { Plotly.Plots.resize('space'); }
  if (name === 'dims') { drawParcoords(); Plotly.Plots.resize('scree'); }
}

// ------------------------------------------------------------------ boot
async function boot() {
  $('#examples').innerHTML = EXAMPLES.map((e) => `<button class="ghost">${esc(e)}</button>`).join('');
  $('#examples').onclick = (ev) => { if (ev.target.tagName === 'BUTTON') { $('#q').value = ev.target.textContent; ask(); } };
  $('#llm').innerHTML = CONFIG.llms.map((l) => `<option value="${l.id}">${esc(l.label)}</option>`).join('');
  // settings persistence
  const fields = ['mode', 'backend', 'k', 'pk', 'budget', 'maxnew', 'temp', 'llm', 'sb-url', 'sb-key', 'layout', 'colorby'];
  const defaults = { 'sb-url': CONFIG.supabaseUrl, 'sb-key': CONFIG.supabaseAnonKey, backend: CONFIG.supabaseUrl ? 'supabase' : 'local' };
  for (const f of fields) {
    const el = document.getElementById(f); const v = store.get(f, defaults[f]);
    if (v !== undefined && v !== null && v !== '') el.value = v;
    el.addEventListener('change', () => { store.set(f, el.value); if (f === 'backend' || f.startsWith('sb-')) storePill(); });
  }
  const storePill = () => { const sb = $('#backend').value === 'supabase'; $('#pill-store').textContent = sb ? 'vector store: Supabase pgvector' : 'vector store: in-browser'; $('#pill-store').className = 'pill ok'; };
  storePill();

  $('#ask').onclick = ask;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
  $('#stop').onclick = () => S.worker.postMessage({ type: 'stop' });
  $('#load').onclick = async () => { try { $('#load').disabled = true; await ensureEmbedder(); await ensureLLM(); } catch (e) { setStatus(e.message); } finally { $('#load').disabled = false; } };
  $('#llm').addEventListener('change', () => { if (S.llmReady !== $('#llm').value) { $('#pill-llm').className = 'pill'; $('#pill-llm').textContent = 'LLM: idle'; } });
  ['#layout', '#colorby', '#show-parents', '#show-tokens'].forEach((s) => $(s).addEventListener('change', updateSpace));
  document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => activateTab(t.dataset.tab)));
  document.body.addEventListener('click', (e) => {
    const v = e.target.closest('[data-v]'); if (v) return showVerse(v.dataset.v);
    const gt = e.target.closest('.gt'); if (gt) { S.selStep = null; showStep(+gt.dataset.step); S.selStep = +gt.dataset.step; }
  });

  S.index = await GitaIndex.load('./data/');
  S.dims = await fetch('./data/dimensions.json').then((r) => r.json());
  for (const v of S.index.verses) { v.pca = S.dims.scores[v.idx].slice(0, 3); S.index.byId.get(v.id).pca = v.pca; }
  for (const s of S.index.sections) {
    const kids = s.verse_ids.map((id) => S.index.byId.get(id));
    s.pca = [0, 1, 2].map((k) => kids.reduce((a, v) => a + v.pca[k], 0) / kids.length);
    S.index.sectionById.get(s.id).pca = s.pca;
  }
  window.gitaIndex = S.index;
  renderIndex(); renderAbout(); renderDims(); updateSpace();
  document.getElementById('space').on('plotly_click', (ev) => {
    const id = ev.points?.[0]?.customdata; if (!id) return;
    if (String(id).startsWith('sec:')) { const s = S.index.sectionById.get(id.slice(4)); showVerse(s.verse_ids[0]); } else showVerse(id);
  });
  startWorker();
  await waitFor((m) => m.type === 'inited');
  document.body.dataset.ready = '1';
}
boot().catch((e) => { console.error(e); setStatus('failed to start: ' + e.message); });
