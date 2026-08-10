// Lexical relevance scoring — the local stand-in for the worker's Postgres
// FTS + pg_trgm seed step. Zero dependencies: token overlap + character-trigram
// Dice similarity. trigramSim doubles as the merge-candidate gate (~0.55).

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'with', 'that', 'this', 'these', 'those',
  'from', 'into', 'onto', 'over', 'under', 'then', 'than', 'when', 'where', 'which',
  'what', 'who', 'how', 'why', 'not', 'but', 'all', 'any', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'have', 'has', 'had', 'been',
  'being', 'its', 'it', 'you', 'your', 'our', 'their', 'they', 'them', 'his', 'her',
  'she', 'him', 'use', 'used', 'using', 'via', 'per', 'each', 'also', 'only', 'very',
]);

export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function trigrams(text: string): Set<string> {
  const s = `  ${(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()} `;
  const out = new Set<string>();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams, 0..1. */
export function trigramSim(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size);
}

/**
 * Relevance of a node to a query: 0.6·token-overlap + 0.4·trigram similarity.
 * Title tokens are counted twice (title matches matter more than body matches).
 */
export function scoreNode(
  query: string,
  node: { title: string; content: string },
  queryTokens?: Set<string>,
): number {
  const q = queryTokens ?? tokenize(query);
  if (q.size === 0) return 0;
  const titleTokens = tokenize(node.title);
  const contentTokens = tokenize(node.content);
  let hits = 0;
  for (const t of q) {
    if (titleTokens.has(t)) hits += 2;
    else if (contentTokens.has(t)) hits += 1;
  }
  const overlap = Math.min(1, hits / q.size);
  const tri = trigramSim(query, `${node.title} ${node.content}`);
  return 0.6 * overlap + 0.4 * tri;
}
