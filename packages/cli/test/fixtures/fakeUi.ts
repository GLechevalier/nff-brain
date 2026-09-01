// A scripted WizardUi: answers come from a queue, every question and note is
// recorded, no TTY anywhere. This is what lets the whole wizard state machine
// run in-process under vitest.

import type { ChecklistResult, ChecklistSection, ProgressHandle } from '../../src/tui/index.js';
import { createStyle, detectGlyphs } from '../../src/tui/index.js';
import type { WizardUi } from '../../src/commands/importWizard.js';

export type Answer =
  | { select: string | null } // matched against String(option.value)
  | { text: string | null }
  | { confirm: boolean | null }
  | { checklist: 'defaults' | 'all' | 'none' | null };

export interface FakeUi extends WizardUi {
  asked: string[]; // every select/text/checklist question, in order
  notes: string[];
  optionsSeen: string[][]; // labels offered per select
}

export function fakeUi(script: Answer[]): FakeUi {
  const queue = [...script];
  const asked: string[] = [];
  const notes: string[] = [];
  const optionsSeen: string[][] = [];

  function next(): Answer {
    const a = queue.shift();
    if (!a) throw new Error(`fakeUi: script exhausted — unanswered question: "${asked.at(-1)}"`);
    return a;
  }

  const noopProgress: ProgressHandle = {
    log: (line: string) => notes.push(line),
    update: () => {},
    stop: (final?: string) => {
      if (final) notes.push(final);
    },
  };

  return {
    style: createStyle(0),
    glyphs: detectGlyphs({ NFF_BRAIN_ASCII: '1' }, 'linux'),
    asked,
    notes,
    optionsSeen,
    note: (line = '') => {
      notes.push(line);
    },
    async select(question, options) {
      asked.push(question);
      optionsSeen.push(options.map((o) => o.label));
      const a = next();
      if (!('select' in a)) throw new Error(`fakeUi: expected a select answer for "${question}"`);
      if (a.select === null) return null;
      const hit = options.find((o) => String(o.value) === a.select);
      if (!hit) throw new Error(`fakeUi: no option with value "${a.select}" for "${question}" — had ${options.map((o) => String(o.value)).join(', ')}`);
      return hit.value;
    },
    async text(question) {
      asked.push(question);
      const a = next();
      if (!('text' in a)) throw new Error(`fakeUi: expected a text answer for "${question}"`);
      return a.text;
    },
    async confirm(question) {
      asked.push(question);
      const a = next();
      if (!('confirm' in a)) throw new Error(`fakeUi: expected a confirm answer for "${question}"`);
      return a.confirm;
    },
    async checklist(question, sections: ChecklistSection[]) {
      asked.push(question);
      const a = next();
      if (!('checklist' in a)) throw new Error(`fakeUi: expected a checklist answer for "${question}"`);
      if (a.checklist === null) return null;
      const all = sections.flatMap((s) => s.items);
      const pick = (fn: (checked: boolean) => boolean): ChecklistResult => ({
        checked: all.filter((i) => fn(i.checked)).map((i) => i.id),
        unchecked: all.filter((i) => !fn(i.checked)).map((i) => i.id),
      });
      if (a.checklist === 'defaults') return pick((c) => c);
      if (a.checklist === 'all') return pick(() => true);
      return pick(() => false);
    },
    progress: () => noopProgress,
    spinner: () => ({ stop: (final?: string) => { if (final) notes.push(final); } }),
    onCancel: () => () => {},
    close: () => {},
  };
}
