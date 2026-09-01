// nff LinkedIn network tracker — paste-into-console capture tool.
//
// Purpose: record LinkedIn's own Voyager API calls (URL + request body +
// response body) to a file you can hand back, so the extraction script can be
// written against REAL payload shapes instead of guesses. This is a throwaway
// discovery tool, not part of the shipped extension.
//
// HOW TO USE
//   1. Open linkedin.com, press F12 → Console.
//   2. Paste this whole file, press Enter. You'll see "capturing…".
//   3. Do the things you want tracked: send a few invites, open your
//      "recently added" connections, send a couple of messages.
//   4. Run:  nffDump()      → downloads linkedin-capture-<time>.txt
//      (or   copy(nffJson()) → puts it on your clipboard if download is blocked)
//   5. Send me that .txt file.
//
// It captures ONLY https://www.linkedin.com/voyager/api/* — no other site, no
// cookies, no headers. Bodies are capped at 1 MB each. Everything stays in this
// tab until you export it.

(() => {
  const w = window;
  if (w.__nffCap) {
    console.log('[nff] already capturing —', w.__nffCap.length, 'calls so far. Run nffDump().');
    return;
  }
  const CAP = (w.__nffCap = []);
  const VOYAGER = 'https://www.linkedin.com/voyager/api/';
  const BODY_MAX = 1024 * 1024;
  const clamp = (s) => (typeof s === 'string' ? s.slice(0, BODY_MAX) : '');

  const record = (method, url, status, reqBody, resBody) => {
    if (!url || url.indexOf(VOYAGER) !== 0) return;
    CAP.push({
      t: new Date().toISOString(),
      method: String(method || 'GET').toUpperCase(),
      url,
      status: status || 0,
      reqBody: clamp(reqBody),
      resBody: clamp(resBody),
    });
  };

  // fetch
  const origFetch = w.fetch;
  if (typeof origFetch === 'function') {
    w.fetch = function (...args) {
      const req = args[0];
      const init = args[1] || {};
      const url = typeof req === 'string' ? req : req && req.url ? req.url : String(req);
      const method = init.method || (req && req.method) || 'GET';
      const reqBody = typeof init.body === 'string' ? init.body : '';
      const p = origFetch.apply(this, args);
      p.then(
        (resp) => {
          if (url.indexOf(VOYAGER) !== 0) return;
          resp
            .clone()
            .text()
            .then(
              (text) => record(method, url, resp.status, reqBody, text),
              () => record(method, url, resp.status, reqBody, ''),
            );
        },
        () => {},
      );
      return p;
    };
  }

  // XMLHttpRequest
  const X = w.XMLHttpRequest;
  if (X && X.prototype) {
    const open = X.prototype.open;
    const send = X.prototype.send;
    X.prototype.open = function (method, url, ...rest) {
      this.__m = method;
      this.__u = url;
      return open.apply(this, [method, url, ...rest]);
    };
    X.prototype.send = function (body) {
      this.addEventListener('load', () => {
        let text = '';
        try {
          text = typeof this.responseText === 'string' ? this.responseText : '';
        } catch {
          /* non-text responseType */
        }
        record(this.__m, this.__u, this.status, typeof body === 'string' ? body : '', text);
      });
      return send.apply(this, [body]);
    };
  }

  w.nffJson = () => CAP.map((e) => JSON.stringify(e)).join('\n');
  w.nffCount = () => CAP.length;
  w.nffDump = () => {
    const blob = new Blob([w.nffJson()], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `linkedin-capture-${Date.now()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    console.log('[nff] downloaded', CAP.length, 'calls');
  };

  console.log('%c[nff] capturing LinkedIn API calls…', 'color:#0a7');
  console.log('[nff] browse/act, then run  nffDump()  (or  copy(nffJson())  ).  nffCount() shows the tally.');
})();
