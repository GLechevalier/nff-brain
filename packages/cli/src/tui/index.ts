// Barrel for the zero-dep TUI layer. Import this lazily from command code —
// hook invocations must never pay for (or touch) any of it.

export { createTerm, type Term, type TermInput, type TermOptions, type TermOutput } from './term.js';
export { createFrame, type Frame } from './frame.js';
export { select, text, confirm, type Option, type PromptOpts } from './prompts.js';
export {
  checklist,
  initChecklist,
  reduceChecklist,
  viewChecklist,
  measureRow,
  ensureVisible,
  type ChecklistItem,
  type ChecklistResult,
  type ChecklistSection,
  type ChecklistState,
  type Row,
  type Viewport,
} from './checklist.js';
export { progress, type ProgressHandle, type ProgressState } from './progress.js';
export { toKey, isCancel, isDown, isSubmit, isToggle, isUp, BYTES, type Key } from './keys.js';
export { createStyle, detectColorLevel, detectGlyphs, type ColorLevel, type Glyphs, type Style } from './style.js';
export { displayWidth, padStartTo, padTo, stripAnsi, truncate, twoColumn, wrap } from './width.js';
