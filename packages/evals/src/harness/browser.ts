// Playwright side of the harness: a persistent Chromium profile with the
// UNPACKED extension loaded (built with NFF_BRAIN_TEST_MANIFEST=1 so optional
// permissions are install-time grants — Chrome's native permission prompt is
// not automatable). Headed on purpose: Google treats headless as hostile, and
// a human must be able to watch an eval run.
//
// The DevTools panel is undrivable (chrome.devtools.* exists only inside a
// real DevTools instance) — which is exactly why goals go through the
// /v1/admin/agent/* routes. The ONLY UI this file drives is the popup, whose
// pairing form and message protocol are ordinary extension pages.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chromium, type BrowserContext, type Page, type Worker } from 'playwright';

// The evaluate() callbacks below execute inside the EXTENSION's realms (SW /
// popup page), where chrome.* exists; this file itself runs in node. One any
// declaration beats pulling @types/chrome into a package that is 99% node.
declare const chrome: any;

export interface BrowserHandle {
  context: BrowserContext;
  extensionId: string;
  sw: Worker;
  /** Pair the extension with the serve instance (no-op if already paired). */
  pair(port: number, code: () => Promise<string>): Promise<void>;
  /** Flip an agent adapter on via the SW message protocol (popup realm = user gesture). */
  enableAgentAdapter(adapterId: string): Promise<void>;
  screenshot(name: string, artifactDir: string): Promise<string>;
  close(): Promise<void>;
}

export interface BrowserOptions {
  evalsRoot: string;
  /** Profile name under .profiles/ — one warmed, human-logged-in profile per site-set. */
  profile: string;
}

function extensionDistPath(evalsRoot: string): string {
  return path.resolve(evalsRoot, '..', 'chrome', 'dist');
}

export async function launchBrowser(opts: BrowserOptions): Promise<BrowserHandle> {
  const dist = extensionDistPath(opts.evalsRoot);
  const manifestPath = path.join(dist, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`missing ${manifestPath} — build the extension first (NFF_BRAIN_TEST_MANIFEST=1 npm run build)`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { host_permissions?: string[] };
  if (manifest.host_permissions === undefined) {
    throw new Error(
      'dist/manifest.json is the PRODUCTION manifest — the harness needs the test variant ' +
        '(rebuild with NFF_BRAIN_TEST_MANIFEST=1) so host/debugger grants are install-time',
    );
  }

  const profileDir = path.join(opts.evalsRoot, '.profiles', opts.profile);
  fs.mkdirSync(profileDir, { recursive: true });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      '--silent-debugger-extension-api',
    ],
  });

  // The MV3 SW may not be up yet; loading any extension page wakes it.
  let sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  }
  const extensionId = new URL(sw.url()).host;

  async function popupPage(): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    return page;
  }

  return {
    context,
    extensionId,
    sw,
    async pair(port, mintCode) {
      // Already paired to THIS serve identity? The popup shows the pair form
      // only when unpaired/rejected — probe storage instead of scraping UI.
      const paired = await sw!.evaluate(async () => {
        const got = (await chrome.storage.local.get('nb.pairing')) as Record<string, unknown>;
        return got['nb.pairing'] !== undefined;
      });
      if (paired) return;

      const code = await mintCode();
      const page = await popupPage();
      try {
        await page.waitForSelector('#pair-form:not(.hidden)', { timeout: 10_000 });
        await page.fill('#port', String(port));
        await page.fill('#code', code);
        await page.click('#connect');
        // Success hides the form; failure surfaces #pair-error.
        await page.waitForSelector('#pair-form.hidden', { timeout: 10_000 }).catch(async () => {
          const err = await page.textContent('#pair-error').catch(() => null);
          throw new Error(`pairing failed: ${err ?? 'no error text'}`);
        });
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async enableAgentAdapter(adapterId) {
      // Same message the panel sends; with the test manifest the host is
      // already granted, so the SW's registration path needs no gesture-bound
      // chrome.permissions.request from us.
      const page = await popupPage();
      try {
        const reply = await page.evaluate(
          (id) => chrome.runtime.sendMessage({ type: 'setAgentAdapterEnabled', id, enabled: true }),
          adapterId,
        );
        if (reply && typeof reply === 'object' && (reply as { error?: string }).error) {
          throw new Error(`setAgentAdapterEnabled(${adapterId}): ${(reply as { error: string }).error}`);
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    },
    async screenshot(name, artifactDir) {
      fs.mkdirSync(artifactDir, { recursive: true });
      const file = path.join(artifactDir, `${name}.png`);
      const page = context.pages().find((p) => !p.url().startsWith('chrome-extension://')) ?? context.pages()[0];
      if (page) await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
      return file;
    },
    async close() {
      await context.close().catch(() => undefined);
    },
  };
}
