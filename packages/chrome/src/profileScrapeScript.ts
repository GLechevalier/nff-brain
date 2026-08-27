// One-shot scrape of the LinkedIn profile TOP CARD, injected at invite time
// via chrome.scripting.executeScript({ func: scrapeProfileTopCard }).
//
// SELF-CONTAINMENT RULE (same as cursorScript.ts): executeScript serializes
// this function with .toString() and runs it in the page's isolated world, so
// it must reference NOTHING from module scope — a closed-over import or const
// arrives in a minified build as a bare renamed identifier and throws
// ReferenceError in the page. Every helper and constant lives inside the
// function; injectedSource.test.ts machine-checks this against the minified
// bundle. Parsing/clamping happens SW-side (recorder.ts) — this returns raw
// visible text and empty strings when a node isn't found; it never guesses.
//
// It only READS the page the user is looking at, at the moment of their own
// send-invite action — the recorder's privacy posture (see privacy-policy.md).

export interface ProfileTopCard {
  name: string;
  headline: string;
  location: string;
}

export function scrapeProfileTopCard(): ProfileTopCard {
  // Shadow-DOM-aware query: LinkedIn renders some surfaces inside open shadow
  // roots, where document.querySelector can't reach.
  var roots: (Document | ShadowRoot)[] = [document];
  var walk = function (node: Element): void {
    if (node.shadowRoot) roots.push(node.shadowRoot);
    var kids = node.children;
    for (var i = 0; i < kids.length; i++) walk(kids[i]);
  };
  walk(document.documentElement);

  var text = function (sel: string): string {
    for (var r = 0; r < roots.length; r++) {
      var el = roots[r].querySelector(sel);
      var t = el?.textContent?.trim().replace(/\s+/g, ' ') ?? '';
      if (t) return t.slice(0, 300);
    }
    return '';
  };

  // Top-card shapes, most-specific first. Class names rot without notice —
  // honest empties are the contract, the SW degrades to name+linkedin.
  var name = text('main h1');
  var headline = text('main .text-body-medium.break-words') || text('main [data-generated-suggestion-target]');
  var location =
    text('main .text-body-small.inline.t-black--light.break-words') ||
    text('main .pv-text-details__left-panel--full-width .text-body-small');
  // The headline node can double as other body-medium text on odd layouts; a
  // headline identical to the name is a misread, not a headline.
  if (headline === name) headline = '';
  if (location === headline || location === name) location = '';
  return { name: name, headline: headline, location: location };
}
