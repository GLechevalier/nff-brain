// LinkedIn agent adapter (item 7): reads search-result cards and clicks
// Connect ONLY on an explicit command from the service worker. Every other
// content script in this extension is deliberately blind and reactive-only
// (see runtime.ts); this one is the sole, narrow exception, kept safe by
// three things: it registers only a fixed, two-verb command channel (never
// arbitrary DOM eval), it never fetches or touches chrome.storage or the
// pairing token (same isolation discipline as every other content script,
// CI-enforced by bundlePurity.test.ts), and it only ever REPLIES via
// sendResponse inside this listener — it never itself calls
// chrome.runtime.sendMessage, so it cannot originate an unsolicited action.
//
// Selector strategy leans on ACCESSIBLE LABELS, same discipline as the
// passive linkedin.ts recorder — LinkedIn's class names churn without
// notice, but a "Connect" button's accessible name is a product surface.
// This file is the one part of the extension that necessarily needs
// periodic live-DOM verification (packages/chrome/README.md's manual
// checklist) — selector rot here is a broken agent run, not a missing clip.

import { isSendInviteLabel } from './linkedinClassify.js';
import { isConnectLabel, nameFromConnectLabel, parseCardText } from './linkedinAgentClassify.js';
import { hideAgentCursor, showAgentClick } from './virtualCursor.js';
import type { ContentToAgentReply, SwToContent } from '../src/protocol.js';

const SEND_MODAL_TIMEOUT_MS = 4000;
const SEND_MODAL_POLL_MS = 200;

interface CardEl {
  root: Element;
  connectButton: HTMLElement | null;
  nameText: string;
  subtitleText: string;
}

function findCards(): CardEl[] {
  // A card is any list item holding a profile link — resilient to a class
  // rename, unlike a class-name selector.
  const items = Array.from(document.querySelectorAll('li')).filter((li) => li.querySelector('a[href*="/in/"]'));
  return items.map((li) => {
    const link = li.querySelector('a[href*="/in/"]');
    const nameText = (link?.textContent?.trim() || link?.getAttribute('aria-label')) ?? '';
    // The subtitle line sits somewhere in the card but is not itself the
    // name link — take the first other non-trivial text node.
    const subtitleText =
      Array.from(li.querySelectorAll('span, div'))
        .map((el) => el.textContent?.trim() ?? '')
        .find((t) => t.length > 0 && t !== nameText && t.length < 200) ?? '';
    const connectButton = Array.from(li.querySelectorAll('button')).find((b) =>
      isConnectLabel(b.getAttribute('aria-label') ?? b.textContent ?? ''),
    ) as HTMLElement | undefined;
    return { root: li, connectButton: connectButton ?? null, nameText, subtitleText };
  });
}

function readCards(): ContentToAgentReply {
  const cards = findCards();
  return {
    ok: true,
    verb: 'readResultCards',
    cards: cards.map((c, i) => ({ cardIndex: i, ...parseCardText(c.nameText, c.subtitleText) })),
  };
}

/**
 * Some LinkedIn flows send the invite the moment Connect is clicked; others
 * open a confirmation modal first. Polls briefly for the SAME send button
 * the passive recorder already detects (isSendInviteLabel) — it is the same
 * button either way, so no second classifier is needed.
 */
function waitForSendButton(timeoutMs = SEND_MODAL_TIMEOUT_MS): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      const dialog = document.querySelector('[role="dialog"], .artdeco-modal');
      const button = dialog
        ? (Array.from(dialog.querySelectorAll('button')).find((b) =>
            isSendInviteLabel(b.getAttribute('aria-label') ?? b.textContent ?? ''),
          ) as HTMLElement | undefined)
        : undefined;
      if (button) {
        resolve(button);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(null);
        return;
      }
      setTimeout(check, SEND_MODAL_POLL_MS);
    };
    check();
  });
}

async function clickConnect(cardIndex: number): Promise<ContentToAgentReply> {
  const card = findCards()[cardIndex];
  if (!card) return { ok: false, error: `no card at index ${cardIndex} — the page may have changed since it was read` };
  if (!card.connectButton) return { ok: false, error: 'no Connect button on that card' };

  const label = card.connectButton.getAttribute('aria-label') ?? card.connectButton.textContent ?? '';
  const { name, headline, company } = parseCardText(nameFromConnectLabel(label, card.nameText), card.subtitleText);
  if (!name) return { ok: false, error: 'could not read a name for that card — refusing to guess' };

  await showAgentClick(card.connectButton);
  card.connectButton.click();
  const sendButton = await waitForSendButton();
  if (sendButton) {
    await showAgentClick(sendButton);
    sendButton.click();
  }
  hideAgentCursor();

  return {
    ok: true,
    verb: 'clickConnect',
    fields: { name, ...(headline ? { headline } : {}), ...(company ? { company } : {}) },
  };
}

chrome.runtime.onMessage.addListener((msg: SwToContent, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (msg.type === 'agentReadCards') {
    sendResponse(readCards());
    return true;
  }
  if (msg.type === 'agentClickConnect') {
    void clickConnect(msg.cardIndex).then(sendResponse);
    return true;
  }
});
