// Pure-ish DOM → semantic descriptor for the trace recorder. Given an element
// the user just interacted with, produce a TargetDescriptor (role, accessible
// name, nearby label/landmark, href) — NEVER a brittle CSS selector path — so
// the recorded step can re-ground semantically at replay time.
//
// Reuses the same role/name/redaction logic the action engine's snapshot uses
// (src/snapshotScript.ts), so a recorded element and a perceived element are
// described the same way. Content-script safe: no chrome.*, no fetch, no
// storage, never sendMessage (that is content/runtime.ts's job).

import { isRedacted, nameFromParts, roleOf } from '../src/snapshotScript.js';

/** Nearest <label> text for a form control, via for= or an ancestor label. */
function labelOf(el: Element): string | null {
  const id = el.getAttribute('id');
  if (id) {
    try {
      const lab = document.querySelector(`label[for="${(window.CSS && CSS.escape ? CSS.escape(id) : id)}"]`);
      if (lab && lab.textContent) return lab.textContent;
    } catch {
      /* bad selector — ignore */
    }
  }
  const anc = el.closest('label');
  return anc && anc.textContent ? anc.textContent : null;
}

/** Nearest landmark/section heading, for "which part of the page" context. */
function landmarkOf(el: Element): string | null {
  const region = el.closest('[role="region"],[aria-label],section,nav,header,footer,main,form,article');
  if (region) {
    const al = region.getAttribute('aria-label');
    if (al) return al;
    const heading = region.querySelector('h1,h2,h3,legend');
    if (heading && heading.textContent) return heading.textContent;
  }
  return null;
}

/** True when the element's value must not be recorded (passwords, cc, otp). */
export function isSensitive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  return isRedacted(tag, el.getAttribute('type'), el.getAttribute('autocomplete'));
}

/**
 * Build the raw descriptor for an element. The SW clamps it through
 * normalizeDescriptor — this side only gathers, never trusts its own output.
 */
export function describeElement(el: Element): Record<string, unknown> {
  const tag = el.tagName.toLowerCase();
  const type = el.getAttribute('type');
  const role = roleOf(tag, el.getAttribute('role'), type);
  const isSubmit = tag === 'input' && (type === 'submit' || type === 'button');
  const name = nameFromParts(
    [
      el.getAttribute('aria-label'),
      labelOf(el),
      el.getAttribute('placeholder'),
      el.getAttribute('alt'),
      el.getAttribute('title'),
      isSubmit ? el.getAttribute('value') : null,
      tag === 'a' || tag === 'button' ? el.textContent : null,
    ],
    120,
  );

  const desc: Record<string, unknown> = { tag, role, name };
  const href = el.getAttribute('href');
  if (href && tag === 'a') desc.href = href;
  const label = labelOf(el);
  if (label) desc.label = label.replace(/\s+/g, ' ').trim().slice(0, 80);
  const landmark = landmarkOf(el);
  if (landmark) desc.landmark = landmark.replace(/\s+/g, ' ').trim().slice(0, 80);

  const attrs: Record<string, string> = {};
  for (const a of ['type', 'name', 'placeholder']) {
    const v = el.getAttribute(a);
    if (v) attrs[a] = v;
  }
  if (Object.keys(attrs).length) desc.attrs = attrs;
  return desc;
}
