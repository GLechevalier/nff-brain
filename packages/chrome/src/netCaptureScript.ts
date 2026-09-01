// The "Record LinkedIn network" capture — the console tracker (tools/linkedin-
// capture/tracker.js) turned into two on-demand executeScript({world:'MAIN'})
// programs, driven by a button in the side panel. `captureInstall` wraps the
// page's fetch/XHR to log every voyager call into window.__nffCap; `captureDump`
// reads that array back. The SW (src/netCapture.ts) injects them into the
// active LinkedIn tab and hands the result to the panel to save as a file.
//
// SELF-CONTAINMENT RULE (test/injectedSource.test.ts): executeScript serializes
// each function via .toString() and runs it in the page, so it may reference
// ONLY page globals — everything here goes through `window.` (plus Date/String),
// nothing from module scope. This is a support/debug capture, NOT part of the
// always-on tracking tap (src/netTapScript.ts).

interface CaptureEntry {
  t: string;
  method: string;
  url: string;
  status: number;
  reqBody: string;
  resBody: string;
}

/** Install the fetch/XHR wrap in the page (idempotent). Runs in the MAIN world. */
export function captureInstall(): void {
  const w = window as unknown as { __nffCap?: CaptureEntry[]; fetch: typeof fetch; XMLHttpRequest: typeof XMLHttpRequest };
  if (w.__nffCap) return;
  const CAP: CaptureEntry[] = (w.__nffCap = []);
  const VOYAGER = 'https://www.linkedin.com/voyager/api/';
  const CAP_MAX = 1500;
  const BODY_MAX = 200 * 1024;
  const clamp = (s: unknown): string => (typeof s === 'string' ? s.slice(0, BODY_MAX) : '');
  const rec = (method: unknown, url: unknown, status: number, reqBody: unknown, resBody: unknown): void => {
    if (typeof url !== 'string' || url.indexOf(VOYAGER) !== 0 || CAP.length >= CAP_MAX) return;
    CAP.push({
      t: new Date().toISOString(),
      method: String(method || 'GET').toUpperCase(),
      url,
      status: status || 0,
      reqBody: clamp(reqBody),
      resBody: clamp(resBody),
    });
  };

  try {
    const of = w.fetch;
    if (typeof of === 'function') {
      w.fetch = function (this: unknown, ...a: Parameters<typeof fetch>): Promise<Response> {
        const req = a[0];
        const init = a[1] || {};
        const url = typeof req === 'string' ? req : req && (req as Request).url ? (req as Request).url : String(req);
        const method = init.method || (req && (req as Request).method) || 'GET';
        const reqBody = typeof init.body === 'string' ? init.body : '';
        const p = of.apply(this, a) as Promise<Response>;
        p.then(
          (resp) => {
            if (url.indexOf(VOYAGER) !== 0) return;
            resp.clone().text().then(
              (t) => rec(method, url, resp.status, reqBody, t),
              () => rec(method, url, resp.status, reqBody, ''),
            );
          },
          () => {},
        );
        return p;
      };
    }
  } catch {
    /* fetch not writable */
  }

  try {
    const X = w.XMLHttpRequest;
    if (X && X.prototype) {
      const open = X.prototype.open;
      const send = X.prototype.send;
      X.prototype.open = function (this: XMLHttpRequest, m: string, u: string, ...r: unknown[]): void {
        (this as unknown as { __m?: string; __u?: string }).__m = m;
        (this as unknown as { __u?: string }).__u = typeof u === 'string' ? u : String(u);
        return open.apply(this, [m, u, ...r] as never);
      };
      X.prototype.send = function (this: XMLHttpRequest, b?: unknown): void {
        const self = this as unknown as { __m?: string; __u?: string };
        this.addEventListener('load', () => {
          let t = '';
          try {
            t = typeof this.responseText === 'string' ? this.responseText : '';
          } catch {
            /* non-text responseType */
          }
          rec(self.__m, self.__u, this.status, typeof b === 'string' ? b : '', t);
        });
        return send.apply(this, [b] as never);
      };
    }
  } catch {
    /* XMLHttpRequest.prototype not writable */
  }
}

/** Read back what has been captured so far (up to CAP_MAX). Runs in the MAIN world. */
export function captureDump(): CaptureEntry[] {
  const w = window as unknown as { __nffCap?: CaptureEntry[] };
  return w.__nffCap && w.__nffCap.slice ? w.__nffCap.slice(-1500) : [];
}

export type { CaptureEntry };
