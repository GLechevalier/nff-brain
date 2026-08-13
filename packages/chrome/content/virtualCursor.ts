// Visual proof of automation (item 7 follow-up): renders a fixed, brand-colored
// pointer + label over the page right before the web agent clicks something,
// so a real click on the user's LinkedIn account never happens invisibly.
//
// The overlay itself lives in src/cursorScript.ts as ONE self-contained
// function, shared with the CDP action engine (src/actEngine.ts) so both the
// recorder agent and the full web agent draw the identical cursor. This file is
// the thin, element-based wrapper the LinkedIn content script uses. Still a
// pure shadow-DOM overlay — no chrome.* API, no network, no storage, never
// calls sendMessage — so it trivially satisfies every content-script purity
// rule in bundlePurity.test.ts.

import { createCursorController } from '../src/cursorScript.js';

/**
 * Glides the overlay to `target`'s center (from wherever it last was) and
 * plays a brief press pulse — resolves once the pulse finishes, right before
 * the caller performs the real click.
 */
export async function showAgentClick(target: Element): Promise<void> {
  target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
  const rect = target.getBoundingClientRect();
  const cursor = createCursorController(document);
  cursor.show();
  await cursor.moveTo(rect.left + rect.width / 2, rect.top + rect.height / 2);
  await cursor.press();
}

/** Fades the overlay out. Safe to call even if it was never shown. */
export function hideAgentCursor(): void {
  createCursorController(document).hide();
}
