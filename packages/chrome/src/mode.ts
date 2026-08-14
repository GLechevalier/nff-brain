// Which brain drives LLM work (the web agent's loop, chat, distillation).
//
// The user's stored preference (nb.brainMode) picks between the paired local
// server and the direct BYOK provider; absent, the legacy rule applies — a
// stored pairing always wins. Either way the resolution is work-or-degrade:
// a preference for a backend that isn't configured falls back to the other
// one rather than dead-ending, so a saved key or a live pairing is never
// silently ignored into an error.
//
// This module decides ROUTING only. Pairing health (ConnectionPhase), the
// server-backed tabs (brain graph, MCP), and clip delivery gates keep reading
// the pairing directly — those are genuinely about the server, not about
// which model backend answers.

import type { BrainMode, BrainModePref } from './schema.js';
import { getBrainModePref, getPairing, getProviderSettings } from './storage.js';

/** Pure half, for tests. Default (pref null) preserves the legacy behavior
 *  exactly: paired if a pairing is stored, else byok if a provider is saved. */
export function deriveBrainMode(
  pref: BrainModePref | null,
  pairingStored: boolean,
  providerConfigured: boolean,
): BrainMode {
  if (pref === 'byok') return providerConfigured ? 'byok' : pairingStored ? 'paired' : 'unconfigured';
  return pairingStored ? 'paired' : providerConfigured ? 'byok' : 'unconfigured';
}

export async function resolveBrainMode(): Promise<BrainMode> {
  const [pref, pairing, provider] = await Promise.all([getBrainModePref(), getPairing(), getProviderSettings()]);
  return deriveBrainMode(pref, pairing !== null, provider !== null);
}
