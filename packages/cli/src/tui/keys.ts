// Keypress normalisation on top of Node's readline decoder.
//
// Verified quirks folded in here so widgets never see them:
//  - Enter is `return` (\r) on real TTYs but `enter` (\n) from pipes and some
//    emulators — accept both.
//  - A lone Esc only decodes after readline's escapeCodeTimeout fires; Esc
//    followed by another key INSIDE that window merges into a single event
//    {meta:true, name:undefined} and the second key is LOST. isCancel matches
//    that merged shape, or Esc-then-Ctrl-C would be swallowed.
//  - In raw mode Ctrl-C is byte 0x03, never SIGINT.

export interface Key {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  sequence: string;
  /** Printable char, or '' for named/control keys. */
  char: string;
}

export interface NodeReadlineKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

const NAMED = new Set([
  'up', 'down', 'left', 'right', 'return', 'enter', 'escape', 'space',
  'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'tab', 'insert',
]);

/** Normalise Node's keypress event into a stable Key. */
export function toKey(str: string | undefined, raw: NodeReadlineKey): Key {
  const name = raw.name ?? '';
  const sequence = raw.sequence ?? str ?? '';
  const printable =
    !raw.ctrl && !raw.meta && !NAMED.has(name) && typeof str === 'string' && str.length > 0 && str >= ' '
      ? str
      : '';
  return {
    name,
    ctrl: raw.ctrl === true,
    meta: raw.meta === true,
    shift: raw.shift === true,
    sequence,
    char: printable,
  };
}

export const isUp = (k: Key): boolean => k.name === 'up' || (k.ctrl && k.name === 'p');
export const isDown = (k: Key): boolean => k.name === 'down' || (k.ctrl && k.name === 'n');
export const isSubmit = (k: Key): boolean => k.name === 'return' || k.name === 'enter';
export const isToggle = (k: Key): boolean => k.name === 'space';
export const isCancel = (k: Key): boolean =>
  k.name === 'escape' ||
  (k.ctrl && (k.name === 'c' || k.name === 'd')) ||
  // Esc+key merged inside the escape window — see header.
  (k.meta && !k.name);

/** Test helper: readable specs → the bytes a terminal would send. */
export const BYTES: Readonly<Record<string, string>> = {
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  enter: '\r',
  space: ' ',
  esc: '\x1b',
  ctrlC: '\x03',
  ctrlD: '\x04',
  backspace: '\x7f',
  delete: '\x1b[3~',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
};
