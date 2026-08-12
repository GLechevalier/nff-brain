import type { ConnectionPhase } from './schema.js';

// The toolbar icon is the only always-visible surface, so it carries exactly one
// bit: is capture actually going to happen right now. Nothing here throws —
// chrome.action calls can reject during shutdown and must never break a probe.

const COLORS: Record<ConnectionPhase, string> = {
  connected: '#1a7f37',
  disconnected: '#b3261e',
  rejected: '#d29922',
  unpaired: '#767676',
};

const TITLES: Record<ConnectionPhase, string> = {
  connected: 'nff-brain — connected',
  disconnected: 'nff-brain — brain not reachable (run `nff-brain serve`)',
  rejected: 'nff-brain — pairing expired, re-pair in the popup',
  unpaired: 'nff-brain — not paired yet',
};

export async function paintBadge(phase: ConnectionPhase, captureEnabled: boolean): Promise<void> {
  try {
    // Paused is worth shouting about even while connected: it is the difference
    // between "this is recording" and "this is not".
    const text = phase === 'connected' ? (captureEnabled ? '' : '❚❚') : '!';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: COLORS[phase] });
    await chrome.action.setTitle({
      title: `${TITLES[phase]}${phase === 'connected' && !captureEnabled ? ' · capture paused' : ''}`,
    });
  } catch {
    /* the action API is unavailable during teardown — never fail a probe */
  }
}

/** Brief confirmation that a right-click actually landed. */
export async function flashCaptured(ok: boolean): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text: ok ? '+1' : 'x' });
    await chrome.action.setBadgeBackgroundColor({ color: ok ? '#1a7f37' : '#b3261e' });
  } catch {
    /* best effort */
  }
}
