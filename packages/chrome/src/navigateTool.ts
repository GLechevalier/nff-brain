// The chat's one browser-control tool (item: standalone chat "navigate to a
// page"). Split like agentGate.ts: pure validation first (testable without a
// browser), the single chrome.tabs call last. Navigates the DevTools-
// inspected tab (chatAsk's tabId, from panel.ts's
// chrome.devtools.inspectedWindow.tabId) IN PLACE rather than opening a new
// one — a new tab has no DevTools attached, which would strand the F12 panel
// the request came from. Falls back to a new tab only if that tab is gone by
// the time this runs.

import type { ToolSpec } from '@nff-brain/core/provider';

export function validateNavigateUrl(raw: unknown): { ok: true; url: string } | { ok: false; reason: string } {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'no url given' };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not a valid url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'only http/https urls can be opened' };
  return { ok: true, url: u.toString() };
}

export const NAVIGATE_TOOL_SPEC: ToolSpec = {
  name: 'navigate',
  description: 'Open a web page in the current browser tab. Use only when the user clearly wants a page opened, not for a casual mention of a link.',
  input_schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The full http or https address of the page to open.' },
    },
    required: ['url'],
  },
};

export async function executeNavigate(input: unknown, tabId: number): Promise<{ ok: boolean; resultText: string }> {
  const v = validateNavigateUrl((input as { url?: unknown } | null)?.url);
  if (!v.ok) return { ok: false, resultText: v.reason };
  try {
    await chrome.tabs.update(tabId, { url: v.url });
    return { ok: true, resultText: `opened ${v.url} in this tab` };
  } catch {
    try {
      await chrome.tabs.create({ url: v.url, active: true });
      return { ok: true, resultText: `opened ${v.url} in a new tab (the original tab was no longer available)` };
    } catch (err) {
      return { ok: false, resultText: err instanceof Error ? err.message : 'could not open the tab' };
    }
  }
}
