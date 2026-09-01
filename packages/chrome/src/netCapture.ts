// SW side of "Record LinkedIn network" — injects the capture programs
// (netCaptureScript.ts) into a tab's MAIN world on demand and reads the result
// back. No storage, no content script, no always-on cost: the wrap exists only
// in the tab the user is recording, for as long as that page lives. The panel
// requests the linkedin host permission (a gesture) before starting; without it
// executeScript throws and the panel shows the error.

import { captureDump, captureInstall, type CaptureEntry } from './netCaptureScript.js';

/** Wrap fetch/XHR in the tab, capturing voyager calls going forward. */
export async function startNetCapture(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    injectImmediately: true,
    func: captureInstall,
  });
}

/** Read back everything captured in the tab since start. */
export async function dumpNetCapture(tabId: number): Promise<CaptureEntry[]> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: captureDump,
  });
  return (res?.result as CaptureEntry[] | undefined) ?? [];
}
