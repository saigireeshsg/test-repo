// Retrieval: child search -> parent aggregation -> context building.
// Two interchangeable backends with identical maths:
//   * Supabase pgvector (RPC match_gita_verses / match_gita_parent_child)
//   * in-browser exact search over the same 700 x 384 matrix (no server needed)

export const W_BEST = 0.6, W_PARENT = 0.25, W_DENSITY = 0.15;

export class GitaIndex {
  static async load(base = './data/') {
    const [ix, ve, se, te] = await Promise.all([
      fetch(base + 'gita_index.json').then((r) => r.json()),
      fetch(base + 'verse_embeddings.f32').then((r) => r.arrayBuffer()),
      fetch(base + 'section_embeddings.f32').then((r) => r.arrayBuffer()),
      fetch(base + 'theme_embeddings.f32').then((r) => r.arrayBuffer()),
    ]);
    return new GitaIndex(ix, new Float32Array(ve), new Float32Array(se), new Float32Array(te));
  }
  constructor(ix, VE, SE, TE) {
    Object.assign(this, ix);
    this.VE = VE; this.SE = SE; this.TE = TE;
    this.byId = new Map(this.verses.map((v, i) => [v.id, { ...v, idx: i }]));
    this.verses = this.verses.map((v, i) => ({ ...v, idx: i }));
    this.sectionById = new Map(this.sections.map((s, i) => [s.id, { ...s, idx: i }]));
    this.sections = this.sections.map((s, i) => ({ ...s, idx: i }));
  }
  dotRow(M, i, q) { let s = 0; const o = i * this.dim; for (let k = 0; k < this.dim; k++) s += M[o + k] * q[k]; return s; }
  projectPCA(q) { const { mean, components } = this.pca; return components.map((c) => c.reduce((s, x, d) => s + x * (q[d] - mean[d]), 0)); }
  // UMAP has no exact out-of-sample transform here: place the query at the similarity-weighted
  // centroid of its nearest neighbours (shown as such in the UI).
  projectUMAP(hits) {
    const top = hits.slice(0, 5); const w = top.map((h) => Math.max(1e-3, h.similarity) ** 4); const W = w.reduce((a, b) => a + b, 0);
    return [0, 1, 2].map((k) => top.reduce((s, h, i) => s + w[i] * this.byId.get(h.id).umap[k], 0) / W);
  }
  themeScores(q) {
    return this.themes.map((t, i) => ({ id: t.id, name: t.name, score: this.dotRow(this.TE, i, q) })).sort((a, b) => b.score - a.score);
  }
  // ---- local backend: brute-force cosine (vectors are L2-normalised so dot == cosine)
  localChildSearch(q, k) {
    const sims = this.verses.map((v) => ({ id: v.id, section_id: v.section_id, similarity: this.dotRow(this.VE, v.idx, q) }));
    sims.sort((a, b) => b.similarity - a.similarity);
    return sims.slice(0, k);
  }
  localParentChild(q, childK, parentK) {
    const hits = this.localChildSearch(q, childK);
    const groups = new Map();
    for (const h of hits) {
      const g = groups.get(h.section_id) || { section_id: h.section_id, best: -1, ids: [] };
      g.best = Math.max(g.best, h.similarity); g.ids.push(h.id); groups.set(h.section_id, g);
    }
    const parents = [...groups.values()].map((g) => {
      const s = this.sectionById.get(g.section_id);
      const parentSim = this.dotRow(this.SE, s.idx, q);
      const density = Math.log(1 + g.ids.length) / Math.log(1 + childK);
      return {
        section_id: s.id, label: s.label, title: s.title, chapter: s.chapter, start_verse: s.start, end_verse: s.end,
        best_child_similarity: g.best, parent_similarity: parentSim, child_hits: g.ids.length,
        score: W_BEST * g.best + W_PARENT * parentSim + W_DENSITY * density, matched_verse_ids: g.ids,
      };
    }).sort((a, b) => b.score - a.score);
    return { hits, parents, allParents: parents, top: parents.slice(0, parentK) };
  }
}

// ---- Supabase backend (PostgREST RPC). Returns the same shapes as the local backend.
export async function supabaseRpc(cfg, fn, args) {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new Error(`Supabase ${fn}: ${res.status} ${await res.text()}`);
  return res.json();
}
export async function supabaseParentChild(cfg, q, childK, parentK) {
  const vec = `[${Array.from(q, (x) => x.toFixed(6)).join(',')}]`;
  const [hits, parents] = await Promise.all([
    supabaseRpc(cfg, 'match_gita_verses', { query_embedding: vec, match_count: childK }),
    supabaseRpc(cfg, 'match_gita_parent_child', { query_embedding: vec, child_count: childK, parent_count: Math.max(parentK, 8) }),
  ]);
  return { hits, parents, allParents: parents, top: parents.slice(0, parentK) };
}

// ---- context building with a token budget (~1.3 tokens per word for these tokenizers)
export const approxTokens = (s) => Math.ceil(s.split(/\s+/).filter(Boolean).length * 1.35);

export function buildContext(index, retrieval, { mode, budget }) {
  const blocks = [];
  let used = 0;
  if (mode === 'child') {
    // child-only: the matched verses themselves, best first
    for (const h of retrieval.hits) {
      const v = index.byId.get(h.id);
      const line = `[${v.id}] ${v.english}`;
      const t = approxTokens(line);
      if (used + t > budget) break;
      used += t;
      blocks.push({ kind: 'child', id: v.id, title: `${v.id} (${index.sectionById.get(v.section_id).title})`, verses: [v.id], text: line, tokens: t });
    }
    return { blocks, used };
  }
  // parent-child (small-to-big): for each top parent, include the whole passage if it fits;
  // otherwise the matched verses plus one neighbour on each side, in reading order.
  for (const p of retrieval.top) {
    const s = index.sectionById.get(p.section_id);
    const all = s.verse_ids.map((id) => index.byId.get(id));
    const full = all.map((v) => `[${v.id}] ${v.english}`).join(' ');
    const remaining = budget - used;
    let chosen = all, text = full, windowed = false;
    if (approxTokens(full) > remaining) {
      const keep = new Set();
      const pos = new Map(all.map((v, i) => [v.id, i]));
      for (const id of p.matched_verse_ids) { const i = pos.get(id); [i - 1, i, i + 1].forEach((j) => j >= 0 && j < all.length && keep.add(j)); }
      chosen = [...keep].sort((a, b) => a - b).map((i) => all[i]);
      // drop the lowest-ranked neighbours until it fits
      while (chosen.length > 1 && approxTokens(chosen.map((v) => v.english).join(' ')) > remaining) {
        const notMatched = chosen.filter((v) => !p.matched_verse_ids.includes(v.id));
        const victim = notMatched.length ? notMatched[notMatched.length - 1] : chosen[chosen.length - 1];
        chosen = chosen.filter((v) => v !== victim);
      }
      let prev = -2; const parts = [];
      for (const v of chosen) { const i = pos.get(v.id); if (prev >= 0 && i !== prev + 1) parts.push('…'); parts.push(`[${v.id}] ${v.english}`); prev = i; }
      text = parts.join(' ');
      windowed = true;
    }
    const t = approxTokens(text);
    if (t > remaining && blocks.length) break;
    used += t;
    blocks.push({ kind: 'parent', id: s.id, title: `${s.label}: ${s.title}`, verses: chosen.map((v) => v.id), matched: p.matched_verse_ids, windowed, text, tokens: t });
    if (used >= budget) break;
  }
  return { blocks, used };
}

export function buildMessages(question, ctx) {
  const passages = ctx.blocks.map((b, i) => `Passage ${i + 1} — ${b.title}\n${b.text}`).join('\n\n');
  return [
    {
      role: 'system',
      content:
        'You are a careful teacher of the Bhagavad Gita. Answer the question using only the passages provided. ' +
        'The passages are from K. M. Ganguli\'s 19th-century English translation; explain them in plain modern English. ' +
        'Cite verse numbers in brackets, like [BG 2.47]. If the passages do not answer the question, say so. Keep it under 150 words.',
    },
    { role: 'user', content: `Passages:\n${passages}\n\nQuestion: ${question}` },
  ];
}
