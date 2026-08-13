import { describe, expect, it } from 'vitest';
import { renderSnapshotHeader, renderSnapshotText, type PageSnapshot, type SnapElement } from '../src/index.js';

function snap(elements: SnapElement[], extra: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    snapshotId: 's3',
    url: 'https://example.com/checkout',
    title: 'Checkout',
    tabId: 7,
    viewport: { w: 1280, h: 720, scrollX: 0, scrollY: 340, pageH: 2900 },
    elements,
    frames: [],
    ...extra,
  };
}

describe('renderSnapshotText', () => {
  it('renders the header, viewport, and a labeled element line', () => {
    const out = renderSnapshotText(
      snap([
        {
          ref: 'e1',
          role: 'textbox',
          name: 'Email',
          value: 'g@x.com',
          rect: { x: 412, y: 180, w: 300, h: 36 },
          inViewport: true,
        },
      ]),
    );
    expect(out).toContain('[s3] https://example.com/checkout — "Checkout"');
    expect(out).toContain('viewport 1280x720 scrolled 0,340 of 2900');
    expect(out).toContain('e1 textbox "Email" value="g@x.com" @412,180 300x36');
  });

  it('marks below-fold elements and renders state flags', () => {
    const out = renderSnapshotText(
      snap([
        {
          ref: 'e3',
          role: 'button',
          name: 'Pay now',
          rect: { x: 412, y: 610, w: 120, h: 44 },
          inViewport: false,
        },
        {
          ref: 'e2',
          role: 'checkbox',
          name: 'Subscribe',
          state: { checked: true },
          rect: { x: 412, y: 230, w: 20, h: 20 },
          inViewport: true,
        },
      ]),
    );
    expect(out).toContain('e3 button "Pay now" @412,610 120x44 [below fold]');
    expect(out).toContain('e2 checkbox "Subscribe" checked @412,230 20x20');
  });

  it('renders a scrollable container marker', () => {
    const out = renderSnapshotText(
      snap([
        {
          ref: 'e4',
          role: 'div',
          name: 'Order summary',
          rect: { x: 760, y: 120, w: 400, h: 520 },
          inViewport: true,
          scrollable: { maxDx: 0, maxDy: 1200 },
        },
      ]),
    );
    expect(out).toContain('e4 div scrollable(maxDy 1200) "Order summary" @760,120 400x520');
  });

  it('never leaks a value when the producer omitted it (password redaction)', () => {
    // A password field is emitted with no `value` key at all.
    const out = renderSnapshotText(
      snap([
        { ref: 'e1', role: 'textbox', name: 'Password', rect: { x: 1, y: 1, w: 10, h: 10 }, inViewport: true },
      ]),
    );
    expect(out).not.toContain('value=');
  });

  it('renders a pending dialog line', () => {
    const out = renderSnapshotText(
      snap([], { dialog: { type: 'confirm', message: 'Leave this page?' } }),
    );
    expect(out).toContain('! dialog confirm: "Leave this page?"');
  });

  it('appends capped text in text mode', () => {
    const out = renderSnapshotText(snap([], { text: 'a'.repeat(9000) }));
    expect(out).toContain('\n---\n');
    // 8000 cap on the text portion.
    expect(out.split('---\n')[1]!.length).toBe(8000);
  });
});

describe('renderSnapshotHeader', () => {
  it('summarizes url and element count', () => {
    const out = renderSnapshotHeader(
      snap([{ ref: 'e1', role: 'button', name: 'Go', rect: { x: 0, y: 0, w: 1, h: 1 }, inViewport: true }]),
    );
    expect(out).toBe('[s3] https://example.com/checkout — 1 interactive elements. Call read_page for detail.');
  });
});
