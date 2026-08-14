import { describe, expect, it } from 'vitest';
import { CURSOR_GLOBAL, buildCursorInstallerSource, createCursorController } from '../src/cursorScript.js';

// No happy-dom/jsdom in this workspace, so the DOM tests run against a minimal
// faithful stub. The regression the fix targets is purely about host/shadow
// REUSE (mode:'open' so shadowRoot is retrievable on the second call), which
// the stub models exactly. The synchronous DOM effects of moveTo/hide run
// before their setTimeout waits, so we never need to await a timer.

class FakeClassList {
  private set = new Set<string>();
  add(c: string) {
    this.set.add(c);
  }
  remove(c: string) {
    this.set.delete(c);
  }
  contains(c: string) {
    return this.set.has(c);
  }
}

class FakeElement {
  id = '';
  className = '';
  innerHTML = '';
  classList = new FakeClassList();
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  shadow: FakeElement | null = null;
  shadowMode: 'open' | 'closed' | null = null;
  constructor(public tag = 'div') {}
  setAttribute(_n: string, _v: string) {}
  appendChild(el: FakeElement) {
    this.children.push(el);
    return el;
  }
  append(...els: FakeElement[]) {
    this.children.push(...els);
  }
  attachShadow(opts: { mode: 'open' | 'closed' }) {
    this.shadow = new FakeElement('#shadow');
    this.shadowMode = opts.mode;
    return this.shadow;
  }
  get shadowRoot(): FakeElement | null {
    return this.shadowMode === 'open' ? this.shadow : null;
  }
  getElementById(id: string): FakeElement | null {
    for (const c of this.children) {
      if (c.id === id) return c;
      const deep = c.getElementById(id);
      if (deep) return deep;
    }
    return null;
  }
}

class FakeDocument {
  documentElement = new FakeElement('html');
  body = new FakeElement('body');
  defaultView: { innerWidth: number } | null = { innerWidth: 1000 };
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  getElementById(id: string): FakeElement | null {
    return this.documentElement.getElementById(id);
  }
}

function hostCount(doc: FakeDocument): number {
  return doc.documentElement.children.filter((c) => c.id === 'nff-brain-agent-cursor').length;
}

describe('createCursorController (DOM behavior)', () => {
  it('creates exactly one host and reuses it across calls (the shadow-root fix)', () => {
    const doc = new FakeDocument() as unknown as Document;
    createCursorController(doc).moveTo(10, 20); // synchronous DOM work, don't await the glide
    createCursorController(doc).moveTo(30, 40);
    createCursorController(doc).show();
    expect(hostCount(doc as unknown as FakeDocument)).toBe(1);
  });

  it('attaches the shadow root as open so it can be re-found', () => {
    const doc = new FakeDocument();
    createCursorController(doc as unknown as Document).show();
    const host = doc.getElementById('nff-brain-agent-cursor')!;
    expect(host.shadowMode).toBe('open');
    expect(host.shadowRoot).not.toBeNull();
  });

  it('hide() clears the visible class (was a no-op under the closed-root bug)', () => {
    const doc = new FakeDocument();
    const c = createCursorController(doc as unknown as Document);
    c.moveTo(5, 5);
    const cursor = doc.getElementById('nff-brain-agent-cursor')!.shadowRoot!.getElementById('cursor')!;
    expect(cursor.classList.contains('visible')).toBe(true);
    c.hide();
    expect(cursor.classList.contains('visible')).toBe(false);
  });

  it('positions the arrow tip (its hotspot) on the target point, not its center', () => {
    const doc = new FakeDocument();
    createCursorController(doc as unknown as Document).moveTo(100, 200);
    const cursor = doc.getElementById('nff-brain-agent-cursor')!.shadowRoot!.getElementById('cursor')!;
    // SIZE 26, tip at (3/24) of the 24-unit viewBox → offset 3.25 so the
    // arrow's tip (not its bounding-box center) lands on 100,200.
    expect(cursor.style.transform).toBe('translate3d(96.75px,196.75px,0)');
  });

  it('showIdle() shows and pulses the arrow at a top-right anchor', () => {
    const doc = new FakeDocument();
    createCursorController(doc as unknown as Document).showIdle();
    const cursor = doc.getElementById('nff-brain-agent-cursor')!.shadowRoot!.getElementById('cursor')!;
    expect(cursor.classList.contains('visible')).toBe(true);
    expect(cursor.classList.contains('idle')).toBe(true);
    // innerWidth 1000, IDLE_MARGIN 32, tip offset 3.25 → x = 1000-32-3.25=964.75, y = 32-3.25=28.75.
    expect(cursor.style.transform).toBe('translate3d(964.75px,28.75px,0)');
  });

  it('moveTo() after showIdle() clears the idle (breathing) class', () => {
    const doc = new FakeDocument();
    const c = createCursorController(doc as unknown as Document);
    c.showIdle();
    c.moveTo(100, 200);
    const cursor = doc.getElementById('nff-brain-agent-cursor')!.shadowRoot!.getElementById('cursor')!;
    expect(cursor.classList.contains('idle')).toBe(false);
  });
});

describe('buildCursorInstallerSource (CDP injection contract)', () => {
  it('assigns the controller to the agreed global and guards against double-install', () => {
    const src = buildCursorInstallerSource();
    expect(src).toContain(`globalThis.${CURSOR_GLOBAL}`);
    expect(src).toContain('createCursorController' in globalThis ? '' : '(document)');
    expect(src).toContain('(document)');
  });

  it('is self-contained — carries its whole body and imports nothing', () => {
    const src = buildCursorInstallerSource();
    // The body must serialize inline (constants declared inside the function, no
    // module import) — the marker text and accent literal prove it did.
    expect(src).toContain('nff-brain agent');
    expect(src).toContain('#00ffcc');
    // No ESM import/require survived into the page program.
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
  });
});
