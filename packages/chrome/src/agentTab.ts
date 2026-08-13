// The web agent runs in its OWN tab, never the DevTools-inspected one. Chrome
// allows a single debugger per tab, and open DevTools already holds that slot —
// so chrome.debugger.attach on the inspected tab fails with "another debugger
// is already attached" and every action then reports "not attached". Opening a
// dedicated tab sidesteps that entirely (the same approach the LinkedIn agent
// takes with ensureAgentTab). The user watches the agent work in this tab while
// the DevTools panel shows the transcript.
//
// No module-level mutable state (MV3): the load listener is per-call and
// removed as soon as it fires.

const LOAD_TIMEOUT_MS = 20_000;

/** Open a fresh, focused tab for the agent at `url` (blank if none), resolved once it finishes loading. */
export async function openAgentTab(url: string): Promise<number> {
  const create: chrome.tabs.CreateProperties =
    url && /^https?:/i.test(url) ? { url, active: true } : { active: true };
  const tab = await chrome.tabs.create(create);
  if (tab.id === undefined) throw new Error('could not open a tab for the agent');
  await waitForComplete(tab.id);
  return tab.id;
}

function waitForComplete(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Already loaded, or the tab vanished — resolve rather than hang.
    chrome.tabs
      .get(tabId)
      .then((t) => {
        if (t.status === 'complete') finish();
      })
      .catch(() => finish());
    setTimeout(finish, LOAD_TIMEOUT_MS);
  });
}
