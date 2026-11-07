-- Bhagavad Gita RAG schema: chapters -> sections (parent chunks) -> verses (child chunks)
-- Embeddings: sentence-transformers/all-MiniLM-L6-v2, 384 dims, L2-normalised (cosine).

create extension if not exists vector with schema extensions;

-- ------------------------------------------------------------------ tables
create table if not exists public.gita_themes (
  id          text primary key,
  name        text not null,
  description text not null,
  embedding   extensions.vector(384)
);

create table if not exists public.gita_chapters (
  chapter        int primary key check (chapter between 1 and 18),
  name_sanskrit  text not null,
  name_english   text not null,
  hexad          text not null check (hexad in ('karma', 'bhakti', 'jnana')),
  summary        text not null,
  verse_count    int  not null
);

-- PARENT chunks: contiguous, thematically coherent passages
create table if not exists public.gita_sections (
  id           text primary key,                      -- 'S08'
  chapter      int  not null references public.gita_chapters(chapter),
  start_verse  int  not null,
  end_verse    int  not null,
  label        text not null,                         -- 'BG 2.39-53'
  title        text not null,
  themes       text[] not null default '{}',
  content      text not null,                         -- full English text of the passage, verse-tagged
  embedding    extensions.vector(384),
  pca          real[],
  umap         real[],
  check (end_verse >= start_verse)
);

-- CHILD chunks: one row per shloka
create table if not exists public.gita_verses (
  id                   text primary key,              -- 'BG 2.47'
  chapter              int  not null references public.gita_chapters(chapter),
  verse                int  not null,
  section_id           text not null references public.gita_sections(id),
  speaker              text not null,
  hexad                text not null,
  primary_theme        text not null references public.gita_themes(id),
  themes               text[] not null default '{}',
  theme_scores         jsonb,
  sanskrit_iast        text not null,
  sanskrit_devanagari  text not null,
  english              text not null,
  alignment            text not null default 'sentence',
  embedding            extensions.vector(384),
  pca                  real[],
  umap                 real[],
  unique (chapter, verse)
);

create index if not exists gita_verses_section_idx on public.gita_verses (section_id);
create index if not exists gita_verses_themes_idx  on public.gita_verses using gin (themes);
create index if not exists gita_verses_embedding_idx
  on public.gita_verses using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists gita_sections_embedding_idx
  on public.gita_sections using hnsw (embedding extensions.vector_cosine_ops);

-- ------------------------------------------------------------------ read-only public access
alter table public.gita_themes   enable row level security;
alter table public.gita_chapters enable row level security;
alter table public.gita_sections enable row level security;
alter table public.gita_verses   enable row level security;

drop policy if exists "gita themes are public"   on public.gita_themes;
drop policy if exists "gita chapters are public" on public.gita_chapters;
drop policy if exists "gita sections are public" on public.gita_sections;
drop policy if exists "gita verses are public"   on public.gita_verses;
create policy "gita themes are public"   on public.gita_themes   for select using (true);
create policy "gita chapters are public" on public.gita_chapters for select using (true);
create policy "gita sections are public" on public.gita_sections for select using (true);
create policy "gita verses are public"   on public.gita_verses   for select using (true);

-- ------------------------------------------------------------------ retrieval: child chunks
create or replace function public.match_gita_verses(
  query_embedding extensions.vector(384),
  match_count     int  default 8,
  filter_chapter  int  default null,
  filter_theme    text default null
)
returns table (
  id text, chapter int, verse int, section_id text, speaker text,
  primary_theme text, english text, sanskrit_iast text, similarity float
)
language sql stable
set search_path = public, extensions
as $$
  select v.id, v.chapter, v.verse, v.section_id, v.speaker, v.primary_theme,
         v.english, v.sanskrit_iast,
         1 - (v.embedding <=> query_embedding) as similarity
  from public.gita_verses v
  where (filter_chapter is null or v.chapter = filter_chapter)
    and (filter_theme   is null or filter_theme = any (v.themes))
  order by v.embedding <=> query_embedding
  limit least(match_count, 50);
$$;

-- ------------------------------------------------------------------ retrieval: parent-child (small-to-big)
-- 1. find the best `child_count` verses by cosine similarity (precise, small chunks)
-- 2. group the hits by their parent section
-- 3. score each parent:  0.60 * best child sim  +  0.25 * parent-vector sim  +  0.15 * hit density
-- 4. return the top `parent_count` parents with their FULL passage text (rich context for the LLM)
create or replace function public.match_gita_parent_child(
  query_embedding extensions.vector(384),
  child_count     int default 12,
  parent_count    int default 3
)
returns table (
  section_id text, label text, title text, chapter int, start_verse int, end_verse int,
  content text, best_child_similarity float, parent_similarity float,
  child_hits int, score float, matched_verse_ids text[]
)
language sql stable
set search_path = public, extensions
as $$
  with hits as (
    select v.id, v.section_id, 1 - (v.embedding <=> query_embedding) as sim
    from public.gita_verses v
    order by v.embedding <=> query_embedding
    limit least(child_count, 50)
  ),
  grouped as (
    select h.section_id,
           max(h.sim)                                   as best_sim,
           count(*)::int                                as n_hits,
           array_agg(h.id order by h.sim desc)          as ids
    from hits h
    group by h.section_id
  )
  select s.id, s.label, s.title, s.chapter, s.start_verse, s.end_verse, s.content,
         g.best_sim,
         1 - (s.embedding <=> query_embedding)          as parent_sim,
         g.n_hits,
         0.60 * g.best_sim
       + 0.25 * (1 - (s.embedding <=> query_embedding))
       + 0.15 * (ln(1 + g.n_hits) / ln(1 + least(child_count, 50)))  as score,
         g.ids
  from grouped g
  join public.gita_sections s on s.id = g.section_id
  order by score desc
  limit parent_count;
$$;

grant usage on schema public to anon, authenticated;
grant select on public.gita_themes, public.gita_chapters, public.gita_sections, public.gita_verses to anon, authenticated;
grant execute on function public.match_gita_verses(extensions.vector, int, int, text) to anon, authenticated;
grant execute on function public.match_gita_parent_child(extensions.vector, int, int) to anon, authenticated;
