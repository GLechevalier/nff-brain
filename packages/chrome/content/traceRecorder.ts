// The task recorder's content script (record-and-automate). Registered
// dynamically ONLY while a recording is active on this tab's origin, it watches
// the user's own interactions with capture-phase listeners and streams semantic
// events to the SW via content/runtime.ts's emitTrace(). It NEVER automates and
// NEVER reads a secret: values from sensitive fields are dropped here at the
// source, and the SW re-validates everything.
//
// Coalescing at the source keeps the trace legible: per-field typing collapses
// to one input event (flushed on blur / Enter / focus-elsewhere), and scroll
// runs collapse to at most one event per direction per window.

import { emitTrace } from './runtime.js';
import { describeElement, isSensitive } from './traceDescriptor.js';

const START = Date.now();
const t = (): number => Date.now() - START;

// Pending typed value per focused field, flushed as one 'input' event.
let pendingInput: { el: Element; value: string; redacted: boolean } | null = null;
let lastScrollAt = 0;

function flushInput(): void {
  if (!pendingInput) return;
  const { el, value, redacted } = pendingInput;
  pendingInput = null;
  emitTrace({ kind: 'input', t: t(), target: describeElement(el), value: redacted ? '' : value, redacted });
}

function onInput(e: Event): void {
  const el = e.target as HTMLElement | null;
  if (!el || !('value' in el)) return;
  const redacted = isSensitive(el);
  if (pendingInput && pendingInput.el !== el) flushInput();
  pendingInput = { el, value: String((el as HTMLInputElement).value ?? ''), redacted };
}

function onChange(e: Event): void {
  const el = e.target as HTMLElement | null;
  if (!el) return;
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    flushInput();
    const sel = el as HTMLSelectElement;
    emitTrace({ kind: 'select', t: t(), target: describeElement(el), value: sel.value });
  } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    emitTrace({ kind: 'input', t: t(), target: describeElement(el), value: el.checked ? 'checked' : 'unchecked' });
  }
}

function onClick(e: Event): void {
  const el = e.target as Element | null;
  if (!el) return;
  // A click elsewhere flushes any pending typing first, preserving order.
  if (pendingInput && pendingInput.el !== el) flushInput();
  const actionable = el.closest('a,button,[role="button"],input,summary,[onclick]') || el;
  emitTrace({ kind: 'click', t: t(), target: describeElement(actionable) });
}

function onSubmit(e: Event): void {
  flushInput();
  const form = e.target as Element | null;
  emitTrace({ kind: 'submit', t: t(), target: form ? describeElement(form) : undefined });
}

function onKeydown(e: Event): void {
  const ke = e as KeyboardEvent;
  if (ke.key !== 'Enter' && ke.key !== 'Escape') return;
  if (ke.key === 'Enter') flushInput();
  const el = ke.target as Element | null;
  emitTrace({ kind: 'key', t: t(), key: ke.key, target: el ? describeElement(el) : undefined });
}

function onScroll(): void {
  const now = Date.now();
  if (now - lastScrollAt < 2000) return; // coalesce scroll runs
  lastScrollAt = now;
  emitTrace({ kind: 'scroll', t: t(), dir: window.scrollY > 0 ? 'down' : 'up' });
}

function onBlur(): void {
  flushInput();
}

// Capture phase so a page that stops propagation can't hide the interaction.
document.addEventListener('click', onClick, { capture: true });
document.addEventListener('submit', onSubmit, { capture: true });
document.addEventListener('input', onInput, { capture: true });
document.addEventListener('change', onChange, { capture: true });
document.addEventListener('keydown', onKeydown, { capture: true });
document.addEventListener('scroll', onScroll, { capture: true, passive: true });
window.addEventListener('beforeunload', onBlur);
