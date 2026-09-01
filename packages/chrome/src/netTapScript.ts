// The LinkedIn network tap (built to dist/rec-linkedin-net.js and registered as
// a MAIN-world content script at document_start — see recorder.ts). It runs in
// the PAGE's own world so it can wrap window.fetch / XMLHttpRequest and observe
// LinkedIn's own Voyager API calls: metadata for every call, plus the request
// body of a message you send and the response body of the "recently added
// connections" list (who accepted you). Neither is visible to chrome.webRequest.
//
// It is deliberately blind and one-directional: it holds no token, reaches no
// network of its own, and only window.postMessage's a compact summary to the
// isolated content script (content/linkedin.ts), which forwards it to the SW
// where all classification, gating, storage and CRM egress happen. A hostile
// page script could forge these messages; the worst case is a spurious local
// net-log row or CRM interaction on the user's own pipeline — the SW re-gates
// on sender.tab.url and the recorder toggle regardless.
// ponytail: same-window postMessage sentinel, no nonce — the confused-deputy
// blast radius here is one CRM row, not credentials; add a nonce if that grows.
//
// Lives in src/ (not content/) on purpose: the content-purity guard forbids the
// literal `fetch(` in content/ files, and this file's whole job is to wrap it.

import { classifyMessageSend, isRecentConnectionsResponse } from './inviteNet.js';

const VOYAGER = 'https://www.linkedin.com/voyager/api/';
const REQ_BODY_MAX = 16 * 1024;
const RES_BODY_MAX = 256 * 1024;

interface TapMsg {
  __nffNet: true;
  url: string;
  method: string;
  status: number;
  reqBody?: string;
  resBody?: string;
}

function post(msg: TapMsg): void {
  try {
    window.postMessage(msg, window.location.origin);
  } catch {
    /* structured-clone / origin edge — drop it, this is best-effort telemetry */
  }
}

/** Emit one tapped call. `readRes` lazily yields the response text only when a
 *  shortlisted endpoint needs it (avoids cloning every response). */
function report(method: string, url: string, status: number, reqBody: string, readRes: () => Promise<string>): void {
  if (!url.startsWith(VOYAGER)) return;
  const base: TapMsg = { __nffNet: true, url, method, status };
  if (classifyMessageSend(method, url) && reqBody) base.reqBody = reqBody.slice(0, REQ_BODY_MAX);
  if (isRecentConnectionsResponse(url) && status >= 200 && status < 300) {
    readRes().then(
      (text) => post({ ...base, resBody: text.slice(0, RES_BODY_MAX) }),
      () => post(base),
    );
    return;
  }
  post(base);
}

function bodyToText(body: unknown): string {
  return typeof body === 'string' ? body : '';
}

function install(): void {
  const w = window as unknown as { __nffNetTap?: boolean };
  if (w.__nffNetTap) return;
  w.__nffNetTap = true;

  // ── fetch ────────────────────────────────────────────────────────────────
  // Each wrap is independently guarded: a page that froze window.fetch must not
  // stop the XHR wrap (or vice versa) from installing.
  try {
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      const req = args[0];
      const init = args[1];
      const url = typeof req === 'string' ? req : req instanceof Request ? req.url : String(req);
      const method = (init?.method || (req instanceof Request ? req.method : 'GET') || 'GET').toUpperCase();
      // Only a string init.body is read; a Request body is a stream, not sync-
      // readable, and voyager sends fetch(url, {body}) anyway.
      const reqBody = bodyToText(init?.body);
      const p = origFetch.apply(this, args as never) as Promise<Response>;
      p.then(
        (resp) => {
          try {
            report(method, url, resp.status, reqBody, () => resp.clone().text());
          } catch {
            /* ignore */
          }
        },
        () => {},
      );
      return p;
    };
  }
  } catch {
    /* window.fetch not writable — leave it, the XHR wrap still installs */
  }

  // ── XMLHttpRequest ─────────────────────────────────────────────────────────
  try {
  const Xhr = window.XMLHttpRequest;
  if (typeof Xhr === 'function') {
    const origOpen = Xhr.prototype.open;
    const origSend = Xhr.prototype.send;
    Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string, ...rest: unknown[]): void {
      (this as unknown as { __nffMethod?: string; __nffUrl?: string }).__nffMethod = method;
      (this as unknown as { __nffUrl?: string }).__nffUrl = typeof url === 'string' ? url : String(url);
      return origOpen.apply(this, [method, url, ...rest] as never);
    };
    Xhr.prototype.send = function (this: XMLHttpRequest, body?: unknown): void {
      const self = this as unknown as { __nffMethod?: string; __nffUrl?: string };
      const method = (self.__nffMethod || 'GET').toUpperCase();
      const url = self.__nffUrl || '';
      const reqBody = bodyToText(body);
      this.addEventListener('load', () => {
        try {
          const text = typeof this.responseText === 'string' ? this.responseText : '';
          report(method, url, this.status, reqBody, () => Promise.resolve(text));
        } catch {
          /* responseText throws for non-text responseType — skip body */
        }
      });
      return origSend.apply(this, [body] as never);
    };
  }
  } catch {
    /* XMLHttpRequest.prototype not writable — nothing more to do */
  }
}

install();
