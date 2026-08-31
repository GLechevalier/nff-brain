// Node ⇄ Markdown round-trip. A brain node renders as a real .md document
// (the VS Code extension serves these through a virtual filesystem, so a node
// opens as a native editor tab), and saving the document writes back: title
// from the `# ` heading, category from the meta blockquote, body from the
// text between them and `## Links`, and the node's edges from the links list.
// Dependency-free (no node:fs) — safe for any bundle.

import { CATEGORIES, asCategory, clampStrength, type BrainNode, type Category } from './types.js';

export interface MdLink {
  id: string;
  strength: number;
  title?: string; // display only — never parsed back
}

export interface ParsedNodeMd {
  title: string;
  category: Category;
  content: string;
  links: MdLink[];
}

// Built from CATEGORIES, never hardcoded: a literal alternation here silently
// dropped any newer category back to the 'strategy' default on re-parse, so a
// no-op save in the VS Code editor rewrote the node's category.
const META_CATEGORY = new RegExp(`category:\\s*(${CATEGORIES.join('|')})\\b`, 'i');

const LINKS_HEADING = /^##\s+links\b/i;
const LINK_LINE = /\[\[([^\]\s]+)\]\](?:[^0-9]*([0-9]*\.?[0-9]+))?/;

export function serializeNodeMd(
  node: BrainNode,
  links: MdLink[],
  extra?: { source?: 'project' | 'global' },
): string {
  const meta = [
    `category: ${node.category}`,
    node.origin === 'seed'
      ? 'curated'
      : node.origin === 'graphify'
        ? 'codebase map'
        : node.origin === 'supabase'
          ? 'database table'
          : node.origin === 'tool'
            ? 'connected tool'
            : node.origin === 'import'
            ? 'imported from history'
            : node.origin === 'clip'
              ? 'clipped from the web'
              : 'learned',
    ...(typeof node.confidence === 'number' ? [`confidence ${node.confidence.toFixed(2)}`] : []),
    // Skill membership, so an editor can see which tree a step belongs to. The
    // token holds no "category:" substring, so META_CATEGORY cannot match it.
    ...(node.skill?.tree
      ? [`skill ${node.skill.tree}${node.skill.path.length ? ` › ${node.skill.path.join(' › ')}` : ''}`]
      : []),
    ...(node.sourceUrl ? [`source ${node.sourceUrl}`] : []),
    `recalled ${node.recallCount ?? 0}×`,
    `updated ${node.lastUpdated}`,
    ...(extra?.source ? [`source ${extra.source}`] : []),
  ].join(' · ');

  const linkLines = links.length
    ? links
        .map((l) => `- [[${l.id}]] — ${l.strength.toFixed(2)}${l.title ? ` (${l.title})` : ''}`)
        .join('\n')
    : `<!-- no links yet — add lines like: - [[node-id]] — 0.6 -->`;

  return [
    `# ${node.title}`,
    ``,
    `> ${meta}`,
    `> _Edit title, category, body or links, then save — changes write back to the brain._`,
    // No literal "category:" here — this line lives in the same blockquote and
    // would match META_CATEGORY if the real meta line above were ever deleted.
    `> _one of: ${CATEGORIES.join(' | ')}_`,
    ``,
    node.content.trim(),
    ``,
    `## Links`,
    ``,
    linkLines,
    ``,
  ].join('\n');
}

export function parseNodeMd(text: string): ParsedNodeMd {
  const lines = (text ?? '').split(/\r?\n/);

  let title = '';
  let category: Category = 'strategy';
  let sawCategory = false;
  const contentLines: string[] = [];
  const links: MdLink[] = [];

  let inLinks = false;
  let pastTitle = false;

  for (const line of lines) {
    if (!pastTitle) {
      const m = line.match(/^#\s+(.+)$/);
      if (m) {
        title = m[1].trim().slice(0, 80);
        pastTitle = true;
      }
      continue; // anything before the first heading is ignored
    }
    if (LINKS_HEADING.test(line)) {
      inLinks = true;
      continue;
    }
    if (inLinks) {
      if (line.trimStart().startsWith('<!--')) continue; // placeholder/hint comments
      const m = line.match(LINK_LINE);
      if (m) {
        const strength = m[2] !== undefined ? Number(m[2]) : 0.6;
        links.push({
          id: m[1].trim(),
          strength: clampStrength(Number.isFinite(strength) ? strength : 0.6),
        });
      }
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      // Meta blockquote: category is the one editable field in it.
      const m = line.match(META_CATEGORY);
      if (m && !sawCategory) {
        category = asCategory(m[1].toLowerCase());
        sawCategory = true;
      }
      continue;
    }
    contentLines.push(line);
  }

  // Dedup links by id (first occurrence wins).
  const seen = new Set<string>();
  const uniqueLinks = links.filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)));

  return {
    title,
    category,
    content: contentLines.join('\n').trim().slice(0, 1200),
    links: uniqueLinks,
  };
}
