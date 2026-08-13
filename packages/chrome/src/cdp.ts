// Thin typed wrapper over chrome.debugger — the ONE place the extension speaks
// CDP. Attaching shows Chrome's "nff-brain is debugging this browser" infobar,
// which is deliberate: the user can always see (and, via the infobar's Cancel,
// stop) the agent. Attach is refused on restricted URLs upstream (actGate
// isRestrictedUrl) so a bad target fails with a clear message, not an opaque
// reject.
//
// No module-level mutable state (MV3 worker discipline): every call re-derives
// attach status from chrome.debugger.getTargets. debugger is an OPTIONAL
// permission — callers must ensure it is granted before reaching here.

const PROTOCOL = '1.3';

export function debuggerAvailable(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.debugger;
}

export async function hasDebuggerPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ permissions: ['debugger'] });
  } catch {
    return false;
  }
}

export async function isAttached(tabId: number): Promise<boolean> {
  try {
    const targets = await chrome.debugger.getTargets();
    return targets.some((t) => t.tabId === tabId && t.attached);
  } catch {
    return false;
  }
}

/** Attach if not already attached, and enable the domains the engine relies on. */
export async function ensureAttached(tabId: number): Promise<void> {
  if (!(await isAttached(tabId))) {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  }
  // Idempotent enables — safe to call every run.
  await send(tabId, 'Page.enable').catch(() => undefined);
  await send(tabId, 'DOM.enable').catch(() => undefined);
  await send(tabId, 'Runtime.enable').catch(() => undefined);
}

export async function detach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* already detached or tab gone — nothing to do */
  }
}

export function send<T = unknown>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  return chrome.debugger.sendCommand({ tabId }, method, params ?? {}) as Promise<T>;
}

interface EvalResult<T> {
  result?: { value?: T };
  exceptionDetails?: { exception?: { description?: string }; text?: string };
}

/**
 * Runtime.evaluate in the page (main world), returned by value. Throws a short
 * message on a page-side exception rather than leaking the CDP shape.
 */
export async function evaluate<T = unknown>(
  tabId: number,
  expression: string,
  opts: { awaitPromise?: boolean } = {},
): Promise<T> {
  const res = await send<EvalResult<T>>(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'page evaluation failed');
  }
  return res.result?.value as T;
}
