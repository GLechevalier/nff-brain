import { pathToFileURL } from 'node:url';
import { embedCacheDir } from './paths.js';
import { resolveTransformers } from './semanticRuntime.js';
import { normalise } from './vector.js';

// NODE-ONLY. Never import this from packages/vscode/webview/** — it would drag
// node:url into the browser bundle. The webview gets query vectors from the
// extension host over postMessage instead.
//
// FAIL-SOFT CONTRACT: every export here returns null (never throws) when the
// optional runtime is missing, the model can't load, or the platform's native
// onnxruntime binary won't bind. Callers treat null as "no semantic tier" and
// fall back to lexical ranking. This mirrors the sibling worker's
// nff-agent-worker/src/roles/agent/brain/embed.ts.

export const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIM = 384;

/**
 * bge is ASYMMETRIC: queries must carry a retrieval prefix, passages must not.
 * Getting this backwards degrades recall quietly, so the prefix lives in
 * exactly one table and is applied in exactly one function (embedQuery).
 * MiniLM is symmetric — empty prefix.
 */
const QUERY_PREFIX: Record<string, string> = {
  'Xenova/bge-small-en-v1.5': 'Represent this sentence for searching relevant passages: ',
  'Xenova/bge-base-en-v1.5': 'Represent this sentence for searching relevant passages: ',
  'Xenova/all-MiniLM-L6-v2': '',
};

export function embedModel(): string {
  return process.env.NFF_BRAIN_EMBED_MODEL ?? DEFAULT_MODEL;
}

function queryPrefix(model: string): string {
  return QUERY_PREFIX[model] ?? '';
}

// esbuild rewrites unanalyzable `import(x)` in CJS output into a require()
// shim, which cannot load an ESM-only package — and the VS Code extension host
// bundle IS CJS. new Function keeps a real dynamic import out of the bundler's
// reach. e2e.test.ts asserts neither built artifact contains a literal require
// of the package name.
const dynamicImport = new Function('u', 'return import(u)') as (u: string) => Promise<any>;

type Extractor = (texts: string[]) => Promise<Float32Array[]>;

let pipelinePromise: Promise<Extractor | null> | null = null;
let lastError: string | null = null;

/** Why the last load attempt failed, for doctor. */
export function embedError(): string | null {
  return lastError;
}

/** Drop the cached pipeline (tests, and a model change within one process). */
export function resetEmbedder(): void {
  pipelinePromise = null;
  lastError = null;
}

async function loadExtractor(): Promise<Extractor | null> {
  const runtime = resolveTransformers();
  if (!runtime.installed || !runtime.entry) {
    lastError = runtime.detail ?? 'semantic runtime not installed';
    return null;
  }
  try {
    const mod = await dynamicImport(pathToFileURL(runtime.entry).href);
    const { pipeline, env } = mod as {
      pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
      env: Record<string, unknown>;
    };
    env.cacheDir = embedCacheDir();
    // After `semantic install` has prefetched the weights, nothing should ever
    // reach the network at search time — an offline machine must degrade to
    // lexical instantly, not hang on a fetch.
    env.allowRemoteModels = process.env.NFF_BRAIN_EMBED_ALLOW_REMOTE === '1';
    const model = embedModel();
    const extractor = (await pipeline('feature-extraction', model, { dtype: 'q8' })) as (
      input: string[],
      opts: Record<string, unknown>,
    ) => Promise<{ tolist(): number[][] }>;
    return async (texts: string[]) => {
      const out = await extractor(texts, { pooling: 'mean', normalize: true });
      return out.tolist().map((row) => Float32Array.from(row));
    };
  } catch (err) {
    lastError = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    return null;
  }
}

/** Lazy process-lifetime singleton — model load is the expensive part. */
function extractor(): Promise<Extractor | null> {
  if (!pipelinePromise) pipelinePromise = loadExtractor();
  return pipelinePromise;
}

/** True when the runtime resolves AND the model actually loads. Loads it. */
export async function embedAvailable(): Promise<boolean> {
  return (await extractor()) !== null;
}

/**
 * Embed passages (node title + content). Returns null when unavailable, or an
 * array positionally matching `texts` with null for any row that failed.
 */
export async function embedTexts(
  texts: string[],
  opts: { batchSize?: number } = {},
): Promise<(Float32Array | null)[] | null> {
  if (texts.length === 0) return [];
  const run = await extractor();
  if (!run) return null;
  const batchSize = opts.batchSize ?? 32;
  const out: (Float32Array | null)[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    try {
      const vecs = await run(batch);
      for (let j = 0; j < batch.length; j++) out.push(vecs[j] ? normalise(vecs[j]!) : null);
    } catch (err) {
      lastError = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      for (let j = 0; j < batch.length; j++) out.push(null);
    }
  }
  return out;
}

/** Embed a search query — applies the model's retrieval prefix. */
export async function embedQuery(query: string): Promise<Float32Array | null> {
  const q = query.trim();
  if (!q) return null;
  const run = await extractor();
  if (!run) return null;
  try {
    const vecs = await run([queryPrefix(embedModel()) + q]);
    return vecs[0] ? normalise(vecs[0]) : null;
  } catch (err) {
    lastError = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    return null;
  }
}

/** The EmbedBatch vectorStore.ts expects. Null-safe by construction. */
export async function embedBatch(texts: string[]): Promise<(Float32Array | null)[]> {
  return (await embedTexts(texts)) ?? texts.map(() => null);
}
