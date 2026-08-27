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
  // Shadow-DOM-aware query: LinkedIn's shell renders inside open shadow roots
  // (possibly nested), where document.querySelector can't reach. The walk
  // descends into every open root it finds.
  var roots: (Document | ShadowRoot)[] = [document];
  var walk = function (node: Element): void {
    if (node.shadowRoot) {
      roots.push(node.shadowRoot);
      var shadowKids = node.shadowRoot.children;
      for (var s = 0; s < shadowKids.length; s++) walk(shadowKids[s]);
    }
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

  // Path 1 — top-card DOM shapes, most-specific first. Class names rot
  // without notice; honest empties are the contract.
  var name = text('main h1') || text('h1');
  var headline = text('main .text-body-medium.break-words') || text('main [data-generated-suggestion-target]');
  var location =
    text('main .text-body-small.inline.t-black--light.break-words') ||
    text('main .pv-text-details__left-panel--full-width .text-body-small');

  // Path 2 — LinkedIn's own embedded data: the initial HTML carries voyager
  // JSON in <code> blobs (light DOM, locale-independent, survives shell
  // redesigns). Find the object whose publicIdentifier matches this page's
  // /in/<slug> and read its headline / geoLocationName. Never guesses: slug
  // mismatch = no result.
  if (!headline || !location) {
    var slugMatch = /\/in\/([^/?#]+)/.exec(location_pathname());
    var slug = slugMatch ? decodeURIComponent(slugMatch[1]) : '';
    if (slug) {
      var blobs = document.querySelectorAll('code');
      for (var b = 0; b < blobs.length && (!headline || !location); b++) {
        var raw = blobs[b].textContent ?? '';
        if (raw.indexOf('"headline"') === -1 || raw.indexOf(slug) === -1) continue;
        var parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        // Iterative search for {publicIdentifier: slug, headline: string}.
        var stack: unknown[] = [parsed];
        while (stack.length) {
          var v = stack.pop() as Record<string, unknown> | null;
          if (!v || typeof v !== 'object') continue;
          if (typeof v['headline'] === 'string' && v['publicIdentifier'] === slug) {
            if (!headline) headline = (v['headline'] as string).trim().replace(/\s+/g, ' ').slice(0, 300);
            if (!location && typeof v['geoLocationName'] === 'string') {
              location = (v['geoLocationName'] as string).trim().slice(0, 300);
            }
            break;
          }
          for (var key in v) {
            if (v[key] && typeof v[key] === 'object') stack.push(v[key]);
          }
        }
      }
    }
  }

  // A headline identical to the name is a misread, not a headline.
  if (headline === name) headline = '';
  if (location === headline || location === name) location = '';
  return { name: name, headline: headline, location: location };

  // Named helper instead of the bare global so the identifier checker sees a
  // binding; `location` the global is shadowed by our local above.
  function location_pathname(): string {
    return window.location.pathname;
  }
}
