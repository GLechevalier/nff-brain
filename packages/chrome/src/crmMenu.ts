// Right-click → "Add to CRM" on linkedin.com. The explicit, on-demand twin of
// the passive invite → CRM path (recorder.ts onLinkedinInviteRequest): same
// scrape, same field shape, same addCrmContact — minus everything that makes
// the passive path silently skip someone (recorder toggle, capture allowlist,
// the per-day dedupe ring). If the user asked, we POST.
//
// Identity: a right-clicked /in/ link names the person; otherwise the page's
// own /in/ URL does. Anything else on linkedin.com (feed, search…) is an
// honest 'failed' activity row, never a guess. The scrape runs under the
// activeTab grant the menu click itself confers — no linkedin host permission
// needed; the CRM POST needs the ingest secret (which granted the admin host).

import { appendActivity } from './activity.js';
import { flashCaptured, paintBadge } from './badge.js';
import { currentPhase } from './connection.js';
import { addCrmContact } from './crmSync.js';
import { nameFromTabTitle } from './inviteNet.js';
import { scrapeProfileTopCard, type ProfileTopCard } from './profileScrapeScript.js';
import { validateRecorderEvent } from './recorderFormat.js';
import { getCapture, getCrmSync } from './storage.js';
import { canonicalProfileUrl } from '../content/linkedinClassify.js';
import { parseCardText } from '../content/linkedinAgentClassify.js';

export const MENU_ID_CRM = 'nb.crm.add';

export const CRM_MENU_ITEM: chrome.contextMenus.CreateProperties = {
  id: MENU_ID_CRM,
  title: 'Add to CRM',
  contexts: ['page', 'link'],
  documentUrlPatterns: ['https://www.linkedin.com/*'],
};

/**
 * Who to add: the right-clicked /in/ link wins, else the page's own profile.
 * `inviteeSlug` is '' when the target IS the page (top-card scrape), and the
 * slug when it isn't (voyager-blob scrape keyed to that person).
 */
export function crmTarget(
  linkUrl: string | undefined,
  pageUrl: string | undefined,
): { linkedin: string; inviteeSlug: string } | null {
  const page = canonicalProfileUrl(pageUrl ?? '');
  const link = canonicalProfileUrl(linkUrl ?? '');
  const linkedin = link || page;
  if (!linkedin) return null;
  return { linkedin, inviteeSlug: linkedin === page ? '' : linkedin.slice('https://www.linkedin.com/in/'.length) };
}

export async function onCrmMenuClicked(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined,
): Promise<void> {
  if (info.menuItemId !== MENU_ID_CRM) return;
  const fail = async (title: string, text: string): Promise<void> => {
    await appendActivity({ id: crypto.randomUUID(), url: tab?.url ?? '', title, text, delivery: 'failed' });
    await flashCaptured(false);
    restoreBadge();
  };

  const cfg = await getCrmSync();
  if (!cfg?.secret) return fail('CRM: not configured', 'Save the CRM ingest secret in Settings first');

  const target = crmTarget(info.linkUrl, tab?.url);
  if (!target || tab?.id === undefined) return fail('CRM: not a LinkedIn profile', tab?.url ?? '');

  // Same best-effort scrape as the invite path; a failure degrades to what the
  // URL + tab title say. Untrusted page text → validateRecorderEvent clamps it.
  let scraped: ProfileTopCard = { name: '', headline: '', location: '' };
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeProfileTopCard,
      args: [target.inviteeSlug],
    });
    if (res?.result) scraped = res.result as ProfileTopCard;
  } catch (err) {
    console.debug('[nff-brain] crm menu scrape failed', err instanceof Error ? err.message : String(err));
  }
  const name = scraped.name || (target.inviteeSlug ? '' : nameFromTabTitle(tab.title ?? ''));
  if (!name) return fail('CRM: could not read a name', target.linkedin);

  const parsed = parseCardText(name, scraped.headline);
  const msg = validateRecorderEvent({
    type: 'recorderEvent',
    adapter: 'linkedin',
    action: 'linkedin.crm_add',
    key: `linkedin.crm_add:${target.linkedin}`,
    at: new Date().toISOString(),
    title: `Add ${name} to CRM`,
    fields: {
      name,
      linkedin: target.linkedin,
      ...(parsed.headline && { headline: parsed.headline }),
      ...(parsed.company && { company: parsed.company }),
      ...(parsed.headline && parsed.role !== parsed.headline && { role: parsed.role }),
      ...(scraped.location && { location: scraped.location }),
    },
  });
  if (!msg) return fail('CRM: could not read a name', target.linkedin);

  const ok = await addCrmContact(msg.fields, msg.at, 'LinkedIn (added from right-click)', cfg.secret, 'crm-menu');
  await flashCaptured(ok);
  restoreBadge();
}

function restoreBadge(): void {
  setTimeout(() => {
    void Promise.all([currentPhase(), getCapture()]).then(([phase, capture]) => paintBadge(phase, capture.enabled));
  }, 1200);
}
