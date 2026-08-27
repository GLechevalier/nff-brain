// LinkedIn search-result card classifiers — PURE (no DOM, no chrome.*).
// LinkedIn's DOM churns without notice; keeping the string logic here means
// rot shows up as a failing test naming the exact pattern, same discipline
// as linkedinClassify.ts.

const NAME_MAX = 80;
const HEADLINE_MAX = 160;
const COMPANY_MAX = 80;

/**
 * Is this the accessible label/text of a search-result card's Connect
 * button? A regex, not startsWith/endsWith — bundlePurity.test.ts pins
 * `.endsWith(` to gate.ts alone (the label-boundary host-matching check),
 * so a second, unrelated use anywhere else would trip that alarm for no
 * reason: this is text-label matching, not host matching.
 */
export function isConnectLabel(label: string): boolean {
  const l = label.trim().toLowerCase();
  return l === 'connect' || /^invite .+ to connect$/.test(l);
}

/** Pull a name out of an "Invite Ada Lovelace to connect" aria-label; falls back to the card's own name text. */
export function nameFromConnectLabel(label: string, fallback: string): string {
  const m = /^invite\s+(.{2,80}?)\s+to connect$/i.exec(label.trim());
  return (m?.[1] ?? fallback).trim().slice(0, NAME_MAX);
}

/**
 * Best-effort split of a card's raw text into name/headline/company/role.
 * LinkedIn headlines are commonly "<Role> at <Company>" / "<Role> @
 * <Company>" / "<Role> chez <Company>" (fr) — when that shape isn't present,
 * company is simply omitted rather than guessed and role is the whole
 * headline.
 */
export function parseCardText(
  nameText: string,
  subtitleText: string,
): { name: string; headline: string; role: string; company?: string } {
  const name = nameText.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
  const headline = subtitleText.trim().replace(/\s+/g, ' ').slice(0, HEADLINE_MAX);
  const m = /^(.*?)\s+(?:at|@|chez)\s+(.+)$/i.exec(headline);
  const company = m?.[2]?.trim().slice(0, COMPANY_MAX);
  const role = (m?.[1]?.trim() || headline).slice(0, HEADLINE_MAX);
  return company ? { name, headline, role, company } : { name, headline, role };
}
