// The Ui seam every terminal wizard drives against — real terminal in
// production (createTerminalUi), scripted fake in tests (test/fixtures/fakeUi.ts).
// Extracted from importWizard.ts so onboard.ts can share it instead of a
// second copy; importWizard.ts re-exports WizardUi so existing imports of it
// keep working unchanged.

import type { ChecklistResult, ChecklistSection, Glyphs, Option, ProgressHandle, Style } from './index.js';

export interface Spinner {
  stop(final?: string): void;
}

export interface WizardUi {
  style: Style;
  glyphs: Glyphs;
  note(line?: string): void;
  confirm(question: string, opts?: { initial?: boolean }): Promise<boolean | null>;
  select<T>(question: string, options: Option<T>[]): Promise<T | null>;
  text(question: string, opts?: { placeholder?: string; default?: string; validate?: (v: string) => string | undefined }): Promise<string | null>;
  checklist(question: string, sections: ChecklistSection[]): Promise<ChecklistResult | null>;
  progress(label: string, total: number): ProgressHandle;
  spinner(label: string): Spinner;
  /** Fires on Esc/Ctrl-C pressed OUTSIDE a widget (i.e. during mining). */
  onCancel(fn: () => void): () => void;
  close(): void;
}

export async function createTerminalUi(): Promise<WizardUi> {
  const tui = await import('./index.js');
  const term = tui.createTerm();
  return {
    style: term.style,
    glyphs: term.glyphs,
    note: (line = '') => term.write(`${line}\n`),
    confirm: (q, o) => tui.confirm(q, { ...o, term }),
    select: (q, o) => tui.select(q, o, { term }),
    text: (q, o) => tui.text(q, { ...o, term }),
    checklist: (q, s) => tui.checklist(q, s, { term }),
    progress: (label, total) => tui.progress({ total, done: 0, active: [] }, { term, label }),
    spinner(label) {
      const frame = tui.createFrame(term, { maxHeight: 1 });
      let tick = 0;
      const paint = (): void =>
        frame.render([`${term.style.accent(term.glyphs.spinner[tick % term.glyphs.spinner.length])} ${label}`]);
      const timer = setInterval(() => {
        tick++;
        paint();
      }, 80);
      timer.unref();
      paint();
      return {
        stop(final) {
          clearInterval(timer);
          frame.close(final !== undefined ? [final] : undefined);
        },
      };
    },
    onCancel: (fn) => term.onKey((k) => {
      if (tui.isCancel(k)) fn();
    }),
    close: () => term.release(),
  };
}
