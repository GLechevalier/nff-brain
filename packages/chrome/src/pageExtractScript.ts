// One-shot extraction of a page's core readable text, injected via
// chrome.scripting.executeScript({ func: extractPageText }) at navigation
// time (pageVisitCapture.ts) — never CDP, so it never shows Chrome's
// "being debugged" bar, which a passive, always-on reader cannot afford.
//
// SELF-CONTAINMENT RULE (same as profileScrapeScript.ts): executeScript
// serializes this function with .toString() and runs it in the page's
// isolated world, so it must reference NOTHING from module scope — every
// helper and constant lives inside the function; injectedSource.test.ts
// machine-checks this against the minified bundle.
//
// Heuristic, not Readability: title + headings + main/article text else body
// text, with nav/header/footer/script/style stripped first. Honest and cheap
// — good enough context for a passively-distilled note, not a faithful
// reader-mode render.

export interface PageExtract {
  title: string;
  text: string;
}

export function extractPageText(): PageExtract {
  var MAX = 4000;
  var title = (document.title || '').trim().slice(0, 300);

  if (!document.body) return { title: title, text: '' };
  var clone = document.body.cloneNode(true) as Element;
  var bad = clone.querySelectorAll('nav, header, footer, script, style, noscript, template');
  for (var i = 0; i < bad.length; i++) bad[i].remove();

  var scope: Element = clone.querySelector('main, article') || clone;

  var heads = scope.querySelectorAll('h1, h2, h3');
  var headLines: string[] = [];
  for (var h = 0; h < heads.length; h++) {
    var t = (heads[h].textContent || '').trim();
    if (t) headLines.push(t);
  }

  var body = (scope as unknown as { innerText?: string }).innerText || scope.textContent || '';
  var text = [title].concat(headLines, [body]).filter(function (s) {
    return !!s;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX);

  return { title: title, text: text };
}
