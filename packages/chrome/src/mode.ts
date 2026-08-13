// Which of the extension's two brains is live. A stored pairing ALWAYS wins —
// flipping to standalone on a transient server outage would fork the brain in
// two places and require a merge later; the stored pairing is the user's
// explicit declaration of where the brain lives. Explicit unpair is the only
// doorway into standalone.

import { getPairing, getProviderSettings } from './storage.js';

export type ExtensionMode = 'paired' | 'standalone' | 'unconfigured';

/** Pure half, for tests. */
export function deriveExtensionMode(pairingStored: boolean, providerConfigured: boolean): ExtensionMode {
  if (pairingStored) return 'paired';
  return providerConfigured ? 'standalone' : 'unconfigured';
}

export async function resolveMode(): Promise<ExtensionMode> {
  const [pairing, provider] = await Promise.all([getPairing(), getProviderSettings()]);
  return deriveExtensionMode(pairing !== null, provider !== null);
}
