import { describe, expect, it } from 'vitest';
import { ATTENTION_GLOBAL, buildAttentionInstallerSource, createAttentionController } from '../src/attentionScript.js';

// Same minimal faithful DOM stub as cursorScript.test.ts (no happy-dom/jsdom in
// this workspace). Extended with a click-capable button so the Stop pill's
// listener can be exercised synchronously.

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
  textContent = '';
  classList = new FakeClassList();
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  shadow: FakeElement | null = null;
  shadowMode: 'open' | 'closed' | null = null;
  listeners: Record<string, Array<() => void>> = {};
  attrs: Record<string, string> = {};
  constructor(public tag = 'div') {}
  setAttribute(n: string, v: string) {
    this.attrs[n] = v;
  }
  private _innerHTML = '';
  get innerHTML(): string {
    return this._innerHTML;
  }
  /**
   * Real innerHTML parses markup into live child nodes; this fake does the same
   * for the flat (non-nested) `<tag class="...">text</tag>` markup the source
   * actually emits, so querySelector('.stop') etc. work the way they would in a
   * real DOM instead of silently seeing an empty children list.
   */
  set innerHTML(html: string) {
    this._innerHTML = html;
    this.children = [];
    const re = /<(\w+)([^>]*)>([^<]*)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const [, tag, attrsStr, text] = m;
      const el = new FakeElement(tag);
      const classMatch = /class="([^"]*)"/.exec(attrsStr!);
      if (classMatch) el.className = classMatch[1]!;
      el.textContent = text!;
      this.children.push(el);
    }
  }
  appendChild(el: FakeElement) {
    el.parentNode = this;
    this.children.push(el);
    return el;
  }
  removeChild(el: FakeElement) {
    const idx = this.children.indexOf(el);
    if (idx >= 0) this.children.splice(idx, 1);
    el.parentNode = null;
    return el;
  }
  append(...els: FakeElement[]) {
    for (const el of els) el.parentNode = this;
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
  querySelector(sel: string): FakeElement | null {
    // Only the two selectors this file actually uses.
    const cls = sel.replace(/^\./, '');
    const walk = (el: FakeElement): FakeElement | null => {
      for (const c of el.children) {
        if (c.className.split(' ').includes(cls)) return c;
        const deep = walk(c);
        if (deep) return deep;
      }
      return null;
    };
    return walk(this);
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    for (const fn of this.listeners['click'] ?? []) fn();
  }
}

class FakeDocument {
  documentElement = new FakeElement('html');
  head = new FakeElement('head');
  body = new FakeElement('body');
  title = '';
  constructor() {
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
  }
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  getElementById(id: string): FakeElement | null {
    return this.documentElement.getElementById(id);
  }
  /** Only the one selector the source actually uses. */
  querySelectorAll(sel: string): FakeElement[] {
    if (sel !== 'link[rel~="icon"]') throw new Error(`unsupported fake selector: ${sel}`);
    return this.head.children.filter((c) => c.tag === 'link' && (c.attrs['rel'] ?? '').split(' ').includes('icon'));
  }
}

function hostCount(doc: FakeDocument): number {
  return doc.documentElement.children.filter((c) => c.id === 'nff-brain-agent-attention').length;
}

describe('createAttentionController (DOM behavior)', () => {
  it('creates exactly one host and reuses it across calls', () => {
    const doc = new FakeDocument() as unknown as Document;
    createAttentionController(doc).show();
    createAttentionController(doc).show();
    expect(hostCount(doc as unknown as FakeDocument)).toBe(1);
  });

  it('attaches the shadow root as open so it can be re-found', () => {
    const doc = new FakeDocument();
    createAttentionController(doc as unknown as Document).show();
    const host = doc.getElementById('nff-brain-agent-attention')!;
    expect(host.shadowMode).toBe('open');
    expect(host.shadowRoot).not.toBeNull();
  });

  it('show() fades the glow border and pill in; hide() fades them out', () => {
    const doc = new FakeDocument();
    const c = createAttentionController(doc as unknown as Document);
    c.show();
    const glow = doc.getElementById('nff-brain-agent-attention')!.shadowRoot!.getElementById('nff-attn-glow')!;
    const pill = doc.getElementById('nff-brain-agent-attention')!.shadowRoot!.getElementById('nff-attn-pill')!;
    expect(glow.classList.contains('visible')).toBe(true);
    expect(pill.classList.contains('visible')).toBe(true);
    c.hide();
    expect(glow.classList.contains('visible')).toBe(false);
    expect(pill.classList.contains('visible')).toBe(false);
  });

  it('a Stop-button click sets the flag; consumeStop() reads it once and clears it', () => {
    const doc = new FakeDocument();
    const c = createAttentionController(doc as unknown as Document);
    c.show();
    expect(c.consumeStop()).toBe(false);
    const pill = doc.getElementById('nff-brain-agent-attention')!.shadowRoot!.getElementById('nff-attn-pill')!;
    const button = pill.querySelector('.stop')!;
    button.click();
    expect(c.consumeStop()).toBe(true);
    // Consuming clears it — a second read is false until another click.
    expect(c.consumeStop()).toBe(false);
  });

  it('a Stop click disables the button and relabels the pill', () => {
    const doc = new FakeDocument();
    const c = createAttentionController(doc as unknown as Document);
    c.show();
    const pill = doc.getElementById('nff-brain-agent-attention')!.shadowRoot!.getElementById('nff-attn-pill')!;
    const button = pill.querySelector('.stop')!;
    const label = pill.querySelector('.label')!;
    button.click();
    expect(button.attrs['disabled']).toBe('true');
    expect(label.textContent).toBe('stopping…');
  });

  it('show() after a Stop click never clears the pending stop request (mid-run reinstall safety)', () => {
    const doc = new FakeDocument();
    const c = createAttentionController(doc as unknown as Document);
    c.show();
    const pill = doc.getElementById('nff-brain-agent-attention')!.shadowRoot!.getElementById('nff-attn-pill')!;
    pill.querySelector('.stop')!.click();
    // actEngine.ts reinstalls (calls show() again) before every interact verb —
    // that must not silently swallow a Stop the user already clicked.
    c.show();
    expect(c.consumeStop()).toBe(true);
  });
});

describe('createAttentionController (tab-strip favicon + title badge)', () => {
  it('show() prefixes the title and installs a teal-dot favicon link', () => {
    const doc = new FakeDocument();
    doc.title = 'Real Page Title';
    createAttentionController(doc as unknown as Document).show();
    expect(doc.title).toBe('● Real Page Title');
    const icons = doc.querySelectorAll('link[rel~="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0]!.attrs['href']).toContain('data:image/svg+xml');
    expect(icons[0]!.attrs['href']).toContain('%2300ffcc'); // encodeURIComponent of #00ffcc
  });

  it('removes the page\'s existing favicon link(s) while badged', () => {
    const doc = new FakeDocument();
    const original = doc.createElement('link');
    original.setAttribute('rel', 'icon');
    original.setAttribute('href', 'https://example.com/favicon.ico');
    doc.head.appendChild(original);
    createAttentionController(doc as unknown as Document).show();
    const icons = doc.querySelectorAll('link[rel~="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0]!.attrs['href']).toContain('data:image/svg+xml'); // ours, not the page's
  });

  it('a second show() (the per-interact-verb reinstall) does not double-prefix the title or stack favicon links', () => {
    const doc = new FakeDocument();
    doc.title = 'Real Page Title';
    const c = createAttentionController(doc as unknown as Document);
    c.show();
    c.show();
    c.show();
    expect(doc.title).toBe('● Real Page Title');
    expect(doc.querySelectorAll('link[rel~="icon"]')).toHaveLength(1);
  });

  it('hide() restores the exact original title and favicon link', () => {
    const doc = new FakeDocument();
    doc.title = 'Real Page Title';
    const original = doc.createElement('link');
    original.setAttribute('rel', 'icon');
    original.setAttribute('href', 'https://example.com/favicon.ico');
    doc.head.appendChild(original);
    const c = createAttentionController(doc as unknown as Document);
    c.show();
    c.hide();
    expect(doc.title).toBe('Real Page Title');
    const icons = doc.querySelectorAll('link[rel~="icon"]');
    expect(icons).toHaveLength(1);
    expect(icons[0]).toBe(original);
    expect(icons[0]!.attrs['href']).toBe('https://example.com/favicon.ico');
  });

  it('hide() leaves no favicon link behind when the page never had one', () => {
    const doc = new FakeDocument();
    doc.title = 'Real Page Title';
    const c = createAttentionController(doc as unknown as Document);
    c.show();
    c.hide();
    expect(doc.title).toBe('Real Page Title');
    expect(doc.querySelectorAll('link[rel~="icon"]')).toHaveLength(0);
  });

  it('hide() is a no-op for the badge when show() was never called', () => {
    const doc = new FakeDocument();
    doc.title = 'Real Page Title';
    createAttentionController(doc as unknown as Document).hide();
    expect(doc.title).toBe('Real Page Title');
    expect(doc.querySelectorAll('link[rel~="icon"]')).toHaveLength(0);
  });
});

describe('buildAttentionInstallerSource (CDP injection contract)', () => {
  it('assigns the controller to the agreed global and guards against double-install', () => {
    const src = buildAttentionInstallerSource();
    expect(src).toContain(`globalThis.${ATTENTION_GLOBAL}`);
    expect(src).toContain('(document)');
  });

  it('is self-contained — carries its whole body and imports nothing', () => {
    const src = buildAttentionInstallerSource();
    expect(src).toContain('nff-brain is active in this tab');
    expect(src).toContain('#00ffcc');
    expect(src).toContain('link[rel~="icon"]'); // the tab-strip favicon badge
    expect(src).not.toMatch(/\bimport\b|\brequire\(/);
  });
});
