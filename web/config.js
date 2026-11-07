// Runtime configuration. Everything can also be changed from the Settings panel in the page
// (values entered there are kept in this browser's localStorage).
export const CONFIG = {
  // Supabase project (pgvector). Leave empty to use the in-browser vector store, which runs the
  // exact same scoring on the same embeddings. The anon key is safe to expose: the tables are
  // read-only for `anon` through row-level security.
  supabaseUrl: '',
  supabaseAnonKey: '',

  // CPU-only inference in the browser (ONNX Runtime WebAssembly)
  transformersUrl: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js',
  embedModel: 'Xenova/all-MiniLM-L6-v2',
  llms: [
    { id: 'HuggingFaceTB/SmolLM2-360M-Instruct', label: 'SmolLM2 360M Instruct (balanced)', dtypes: ['q4', 'q8', 'fp32'] },
    { id: 'HuggingFaceTB/SmolLM2-135M-Instruct', label: 'SmolLM2 135M Instruct (fastest)', dtypes: ['q4', 'q8', 'fp32'] },
    { id: 'onnx-community/Qwen2.5-0.5B-Instruct', label: 'Qwen2.5 0.5B Instruct (best answers, largest)', dtypes: ['q4', 'q8'] },
  ],
  // Optional self-hosted model mirror (e.g. a CDN or Supabase Storage bucket) laid out as
  // <modelHost>/<org>/<model>/<file>. null = download from the Hugging Face Hub.
  modelHost: null,
  // Optional override for where ONNX Runtime fetches its .wasm files (default: jsDelivr).
  wasmPaths: null,
  // Who writes the answer: 'cpu' = the in-browser LLM above (shows per-token probabilities);
  // 'claude' = Claude through the artifact `sample` capability (used by the published artifact,
  // whose host blocks model downloads). The artifact build script sets these two fields.
  generator: 'cpu',
  // Artifact build only: model files + ONNX Runtime wasm shipped inside the page.
  bundle: null,
};
