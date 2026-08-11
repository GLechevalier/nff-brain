import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Browser-safe subpath import — see the note at the top of App.tsx.
import { decodeVector, topKBySim, type SimHit } from '@nff-brain/core/vector';
import type { ExtToWeb, ViewVectorEntry, WebToExt } from '../src/protocol';

// Semantic half of the search box. The rule that makes this safe: lexical
// results are rendered SYNCHRONOUSLY on every keystroke (App.tsx), and this
// hook only ever returns extra ranking signal once it arrives. It can be slow,
// it can fail, it can be switched off — the search box never regresses.
//
// The model lives in the extension host (node-only native runtime; the webview
// CSP forbids wasm-eval anyway). We hold precomputed node vectors and ask the
// host to embed each settled query.

const DEBOUNCE_MS = 180;
/** Query vectors are stable per string — remember recent ones so backspacing
 *  and retyping is instant instead of round-tripping the host again. */
const CACHE_MAX = 60;

interface Options {
  query: string;
  limit?: number;
  post: (msg: WebToExt) => void;
}

export interface SemanticSearch {
  /** Cosine hits for the CURRENT query, or null → caller stays lexical-only. */
  hits: SimHit[] | null;
  enabled: boolean;
  /** Feed every ExtToWeb message here from App's existing listener. */
  onMessage: (msg: ExtToWeb) => void;
}

export function useSemanticSearch({ query, limit = 30, post }: Options): SemanticSearch {
  const [enabled, setEnabled] = useState(false);
  const [vectors, setVectors] = useState<Map<string, Float32Array>>(() => new Map());
  // The query vector currently applicable, paired with the query it belongs to
  // so a stale answer can never be applied to newer text.
  const [current, setCurrent] = useState<{ q: string; v: Float32Array } | null>(null);

  const cache = useRef(new Map<string, Float32Array>());
  const seq = useRef(0);
  const pending = useRef(new Map<number, string>());

  const onMessage = useCallback((msg: ExtToWeb) => {
    if (msg.type === 'vectors') {
      const next = new Map<string, Float32Array>();
      for (const e of msg.entries as ViewVectorEntry[]) {
        const v = decodeVector(e.v, msg.dim || undefined);
        if (v) next.set(e.id, v);
      }
      setVectors(next);
      setEnabled(msg.enabled && next.size > 0);
      // Vectors changed ⇒ any cached query vector is still valid (queries are
      // embedded with the same model), so only the node side is replaced.
      return;
    }
    if (msg.type === 'queryVector') {
      const q = pending.current.get(msg.seq);
      pending.current.delete(msg.seq);
      if (q === undefined) return; // superseded — drop it
      if (!msg.v) return;
      const v = decodeVector(msg.v);
      if (!v) return;
      if (cache.current.size >= CACHE_MAX) {
        const oldest = cache.current.keys().next().value;
        if (oldest !== undefined) cache.current.delete(oldest);
      }
      cache.current.set(q, v);
      setCurrent({ q, v });
    }
  }, []);

  // Ask the host to embed the query once typing settles.
  useEffect(() => {
    const q = query.trim();
    if (!enabled || !q) {
      setCurrent(null);
      return;
    }
    const cached = cache.current.get(q);
    if (cached) {
      setCurrent({ q, v: cached });
      return;
    }
    const timer = window.setTimeout(() => {
      const id = ++seq.current;
      // Only the newest request may resolve; older ones are dropped on arrival.
      pending.current.clear();
      pending.current.set(id, q);
      post({ type: 'embedQuery', query: q, seq: id });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, enabled, post]);

  const hits = useMemo(() => {
    const q = query.trim();
    // Strict match: while the user is mid-word the vector belongs to older
    // text, so we fall back to lexical-only rather than rank against the wrong
    // query. This is why the box never "flickers wrong".
    if (!enabled || !q || !current || current.q !== q || vectors.size === 0) return null;
    return topKBySim(current.v, vectors, limit);
  }, [enabled, query, current, vectors, limit]);

  return { hits, enabled, onMessage };
}
