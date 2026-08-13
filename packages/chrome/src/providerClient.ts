// The fetch half of the BYOK provider layer. Adapters (@nff-brain/core/provider)
// are pure build/parse; this module is the ONLY place a provider request is
// actually sent, and the only chrome module that imports the provider subpath.
//
// Error contract for callers:
//   - 'background' slot (standalone drain): FAIL-OPEN — catch, leave the batch
//     queued, back off to the next alarm tick. Exception: a ProviderError with
//     kind 'auth' is ALSO persisted into settings.lastTest here, because a dead
//     key silently retried forever is the 401-vs-disconnect lesson from
//     ConnectionPhase 'rejected'. The drain still fails open; the options page
//     and popup render the flag.
//   - 'chat' slot: surface ProviderError.message to the panel — it is short and
//     user-showable by construction (never the key, never a stack).
//
// NO module-level state (pinned by bundlePurity) — settings are read from
// storage at call time, so a key change applies to the very next call.

import { PROVIDERS, ProviderError } from '@nff-brain/core/provider';
import type { ModelSlot, ProviderRequest } from '@nff-brain/core/provider';
import type { ProviderTestResult } from './schema.js';
import { getProviderSettings, setProviderSettings } from './storage.js';

export type OneShot = (prompt: string) => Promise<string>;

/** background mirrors runClaude's 60s; chat mirrors the serve chat route's 45s. */
export const PROVIDER_TIMEOUT_MS: Record<ModelSlot, number> = { background: 60_000, chat: 45_000 };

const MAX_TOKENS: Record<ModelSlot, number> = { background: 4096, chat: 4096 };

async function send(req: ProviderRequest, timeoutMs: number): Promise<{ status: number; body: string }> {
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Timeout and network failures are the same thing to a caller: retryable.
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new ProviderError('overloaded', timedOut ? 'the provider did not answer in time' : 'could not reach the provider');
  }
  return { status: res.status, body: await res.text() };
}

/** Flag a dead key where the UI can see it, without changing the thrown error. */
async function recordAuthFailure(message: string): Promise<void> {
  const s = await getProviderSettings();
  if (!s) return;
  await setProviderSettings({ ...s, lastTest: { ok: false, at: new Date().toISOString(), message } });
}

/**
 * Null means "no provider configured" — the caller decides what that implies
 * (the drain waits; chat replies with a pointer at the options page).
 */
export async function makeProviderOneShot(slot: ModelSlot): Promise<OneShot | null> {
  const s = await getProviderSettings();
  const adapter = s && PROVIDERS[s.provider];
  if (!s || !adapter) return null;
  const model = s.models[slot] || adapter.defaultModels[slot];

  return async (prompt) => {
    const req = adapter.buildRequest(
      { prompt, model, maxTokens: MAX_TOKENS[slot], jsonHint: slot === 'background' },
      s.apiKey,
    );
    const { status, body } = await send(req, PROVIDER_TIMEOUT_MS[slot]);
    try {
      return adapter.parseResponse(status, body);
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth') await recordAuthFailure(err.message);
      throw err;
    }
  };
}

/** The options page's "Test connection": cheapest authenticated round trip. */
export async function testProviderKey(): Promise<ProviderTestResult> {
  const at = new Date().toISOString();
  const s = await getProviderSettings();
  const adapter = s && PROVIDERS[s.provider];
  if (!s || !adapter) return { ok: false, at, message: 'no API key saved yet' };

  let result: ProviderTestResult;
  try {
    const { status, body } = await send(adapter.buildKeyTestRequest(s.apiKey), 15_000);
    adapter.parseResponse(status, body);
    result = { ok: true, at, message: 'key accepted' };
  } catch (err) {
    if (err instanceof ProviderError) {
      // rate_limit/overloaded mean auth SUCCEEDED — key fine, service busy.
      // malformed/refusal only occur on a 2xx (a 1-token reply can parse as
      // "empty"), so those prove the key works too. Only auth/bad_request are
      // real failures.
      if (err.retryable) result = { ok: true, at, message: 'key accepted (provider busy, try again later)' };
      else if (err.kind === 'malformed' || err.kind === 'refusal') result = { ok: true, at, message: 'key accepted' };
      else result = { ok: false, at, message: err.kind === 'auth' ? 'invalid API key' : err.message };
    } else {
      result = { ok: false, at, message: 'could not reach the provider' };
    }
  }
  await setProviderSettings({ ...s, lastTest: result });
  return result;
}
