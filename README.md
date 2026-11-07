# Gita RAG Lab

A retrieval-augmented generation system over the full **Bhagavad Gita (700 shlokas)**. It has a thematic index, parent-child chunking, a pgvector store on Supabase, and a **CPU-only LLM that runs in your browser**. Every step of answering a question is shown live:

1. the question's WordPiece tokens,
2. its 384-d embedding (per-token vectors → mean pooling),
3. cosine search over the 700 verse vectors,
4. parent (passage) expansion with the score breakdown,
5. the assembled prompt and the LLM's own tokens,
6. token-by-token generation: each step shows the softmax top-10 next-token candidates, the chosen token, its rank, and the entropy.

All 700 verses are plotted in a rotatable **3-D embedding space** (UMAP or PCA). The question appears as a point among them, with lines to the verses it retrieved.

```
data/sources/           public-domain inputs (Sanskrit; Ganguli's English)
data/verses.json        700 verses: Devanagari, IAST, English, speaker, alignment flag
data/taxonomy.json      hexads, 18 chapter summaries, 19 themes, 78 passages (parent chunks)
pipeline/               01 build verses → 02 embed/index/project → 03 Supabase seed/upload
supabase/migrations/    pgvector schema, HNSW indexes, RLS, retrieval RPCs
supabase/seed.sql       generated: all rows + embeddings
web/                    static app (no build step): index.html, app.js, worker.js, retrieval.js
web/data/               index JSON + float32 embedding matrices used by the browser
```

## Run it

```bash
npm run serve
```

Then open http://localhost:8080. The first question downloads the embedder (~90 MB) and the chosen LLM from the Hugging Face Hub. After that the browser caches them.

## Thematic structure

| Level | Count | What it is |
|---|---|---|
| Hexad | 3 | Chapters 1–6 **Karma** (action) · 7–12 **Bhakti** (devotion) · 13–18 **Jnana** (knowledge) |
| Chapter | 18 | e.g. 2 *Sankhya Yoga*, 11 *Vishvarupa Darshana Yoga*, 18 *Moksha Sannyasa Yoga* |
| Passage (parent chunk) | 78 | A contiguous verse range with one teaching, e.g. *BG 2.11–30 The Self is eternal*, *BG 3.36–43 Desire and anger: the real enemy* |
| Verse (child chunk) | 700 | One shloka |

Each verse has a **primary theme** (from its curated passage) and up to two **secondary themes**, added where its embedding is close to another theme's description. There are 19 themes: battlefield narrative, Arjuna's crisis, Atman, svadharma, karma yoga, equanimity, mind/senses/desire, yajna, jnana, dhyana, bhakti, divine nature and vibhutis, the cosmic form, creation/death/rebirth, the three gunas, field and knower, divine vs. demonic qualities, faith, and renunciation/moksha.

## How it works

**Sources.** The Sanskrit uses the standard 700-verse numbering. The English is **K. M. Ganguli's** translation (Mahabharata, Bhishma Parva XXV–XLII, 1883–96), which is public domain. Ganguli wrote continuous prose, so `01_build_verses.py` splits it into clauses and aligns them to the verses with a monotonic dynamic programme. The programme uses only public-domain signals:
- speaker markers (*arjuna uvāca* ↔ "Arjuna said"),
- a Sanskrit→English cue lexicon (vocatives such as *kaunteya* ↔ "son of Kunti", plus names and key terms),
- a syllable-length prior.

About 92 % of verses begin on a Ganguli sentence boundary. The rest (`"alignment": "clause"`) are where he runs two verses into one sentence, such as army rosters and lists of virtues.

**Embeddings.** `all-MiniLM-L6-v2` (384-d, mean-pooled, L2-normalised), the same ONNX weights the browser runs. Each child is embedded with a contextual header, `<passage title> (<chapter name>): <verse>`. This clearly improved matching of modern questions to the archaic English: "How do I control my anger?" now retrieves BG 3.37–43, and "How should I meditate?" retrieves 6.11–16. A parent's vector is the centroid of its children, blended 3:1 with the vector of its title.

**Parent-child retrieval (small-to-big).**
1. Retrieve the top-k verses (precise matches).
2. Group them by passage.
3. Rank passages by `0.60·best child + 0.25·passage vector + 0.15·log-density of hits`.
4. Send the top passages to the LLM: whole if they fit the token budget, otherwise windowed to the matched verses ± 1 neighbour.

You can switch to *child chunks only* in Settings to compare. The same scoring runs in SQL (`match_gita_parent_child`) and in the browser.

**Generation on the CPU.** The LLM runs in a Web Worker on ONNX Runtime WebAssembly via transformers.js. You can choose SmolLM2-360M (default), SmolLM2-135M or Qwen2.5-0.5B, all 4-bit. A custom `LogitsProcessor` reads the final logits at each step, so the UI shows the real distribution each token was drawn from. For multi-threaded WASM, serve the page with COOP/COEP headers; without them it uses one thread.

## Supabase

1. Create a project. Run `supabase/migrations/20261107000000_gita_rag.sql`, then `supabase/seed.sql`, in the SQL editor (or use `supabase db reset` with the CLI).
   - Alternatively, load the data with `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… npm run upload:supabase`.
2. In the app, open **Settings**: choose *Supabase pgvector*, and paste the project URL and **anon** key. You can also set them in `web/config.js`. The tables are read-only to `anon` through RLS.

RPCs:
- `match_gita_verses(query_embedding, match_count, filter_chapter, filter_theme)`
- `match_gita_parent_child(query_embedding, child_count, parent_count)`

## Rebuild the index

```bash
pip install -r requirements.txt && npm install
```

```bash
npm run build
```

`npm run build` downloads the embedder from the Hub. To use local weights, set `MODEL_DIR` to a directory containing `Xenova/all-MiniLM-L6-v2/`.

## Tested

- The migration, seed and both RPCs were run on Postgres + pgvector (PGlite).
- The full browser flow was run end to end in headless Chromium on CPU/WASM. Because the Hugging Face Hub was unreachable from the build machine, generation was exercised with a tiny stand-in decoder that has the same ONNX interface. The real models listed above are not yet verified in this setup.
