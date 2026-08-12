// Pure DOM renderers for the Brain panel — no chrome.*, same separation as
// popup/paint.ts. Every piece of node text goes through textContent, never
// innerHTML: brain content is data, not markup.

import type { NodeSummary, NodesResponse, SearchHit, SearchResponse } from '../src/protocol.js';

const $ = (id: string): HTMLElement => document.getElementById(id)!;

export function paintHeader(nodes: NodesResponse | null, connected: boolean): void {
  const dot = $('dot');
  dot.classList.toggle('connected', connected);
  dot.classList.toggle('disconnected', !connected);
  $('disconnected').classList.toggle('hidden', connected);
  if (!nodes) return;
  $('workspace').textContent = nodes.workspace.name;
  $('counts').textContent =
    `${nodes.merged.nodes} nodes (${nodes.workspace.nodes} project · ${nodes.global.nodes} global)`;
  $('updated').textContent = nodes.updatedAt ? `updated ${nodes.updatedAt.slice(0, 16).replace('T', ' ')}` : '';
}

function hitLi(n: NodeSummary & Partial<SearchHit>): HTMLLIElement {
  const li = document.createElement('li');

  const head = document.createElement('div');
  head.className = 'hit-head';
  const chip = document.createElement('span');
  chip.className = n.origin === 'clip' ? 'chip clip' : 'chip';
  chip.textContent = n.origin === 'clip' ? 'clip' : n.category;
  const title = document.createElement('span');
  title.className = 'hit-title';
  title.textContent = n.title;
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = n.source;
  head.append(chip, title, badge);
  li.append(head);

  if (n.excerpt) {
    const ex = document.createElement('div');
    ex.className = 'hit-excerpt';
    ex.textContent = n.excerpt;
    li.append(ex);
  }
  if (n.related && n.related.length > 0) {
    const rel = document.createElement('div');
    rel.className = 'hit-related';
    rel.textContent = `↳ related: ${n.related.map((r) => r.title).join(', ')}`;
    li.append(rel);
  }
  return li;
}

/** The Search tab: results for a query, or the recent list when the box is empty. */
export function paintResults(hits: readonly (NodeSummary & Partial<SearchHit>)[], label: string): void {
  $('results-label').textContent = label;
  const ul = $('results');
  ul.replaceChildren(...hits.map((h) => hitLi(h)));
}

/** One Ask exchange appended to the transcript. */
export function paintAnswer(q: string, res: SearchResponse): void {
  const t = $('transcript');

  const qEl = document.createElement('div');
  qEl.className = 'msg-q';
  qEl.textContent = q;
  t.append(qEl);

  const a = document.createElement('div');
  a.className = 'msg-a';
  if (res.hits.length === 0) {
    const none = document.createElement('div');
    none.className = 'empty-answer';
    none.textContent = 'Nothing in the brain matches that yet — lessons land after Claude Code sessions end.';
    a.append(none);
  } else {
    const lead = document.createElement('div');
    lead.className = 'lead';
    lead.textContent = `Your brain has ${res.hits.length} note${res.hits.length === 1 ? '' : 's'} on this:`;
    a.append(lead);
    const ul = document.createElement('ul');
    ul.className = 'list';
    ul.append(...res.hits.map((h) => hitLi(h)));
    a.append(ul);
  }
  t.append(a);
  a.scrollIntoView({ block: 'end' });
}

export function switchTab(tab: 'search' | 'ask'): void {
  $('tab-search').classList.toggle('active', tab === 'search');
  $('tab-ask').classList.toggle('active', tab === 'ask');
  $('search-view').classList.toggle('hidden', tab !== 'search');
  $('ask-view').classList.toggle('hidden', tab !== 'ask');
}
