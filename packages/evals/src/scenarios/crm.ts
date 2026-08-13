// CRM ladder — user decision: Notion is the customer-representative CRM
// surface (a Deals database), and the nff-admin CRM (MCP-writable) doubles as
// the list-write target. The stalled-deal seed backdates LastActivity 30 days.

import { defineScenario } from '../scenario.js';
import type { Oracles } from '../oracles/types.js';
import { mustMention, runAnswerText } from './helpers.js';

interface CrmSeed {
  pageIds: string[];
  stalledName: string;
  freshNames: string[];
}

export const crmStalledL1 = defineScenario<CrmSeed>({
  id: 'crm.stalled.L1',
  category: 'crm',
  level: 1,
  title: 'Which deals are stalled and what is the total pipeline value?',
  requires: ['P2-loop', 'P3-adapter:notion'],
  sites: ['notion'],
  goal: 'Open the Deals database in Notion and tell me which deals look stalled (no activity for weeks) and the total pipeline value. Read-only: change nothing.',
  mode: 'plan-approve',
  maxActions: 6,
  reps: 3,
  passRate: 0.66,
  async seed(o: Oracles, nonce: string): Promise<CrmSeed> {
    const notion = o.notion!;
    const stalledName = `Acme retrofit ${nonce}`;
    const freshNames = [`Globex rollout ${nonce}`, `Initech pilot ${nonce}`];
    const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const a = await notion.createDeal({ name: stalledName, stage: 'Negotiation', amount: 42000, lastActivityIso: monthAgo });
    const b = await notion.createDeal({ name: freshNames[0], stage: 'Proposal', amount: 18000, lastActivityIso: yesterday });
    const c = await notion.createDeal({ name: freshNames[1], stage: 'Discovery', amount: 9000, lastActivityIso: yesterday });
    return { pageIds: [a.id, b.id, c.id], stalledName, freshNames };
  },
  async verify(_o, run, seed) {
    // The stalled deal must be named; naming only fresh deals is a fail.
    const text = runAnswerText(run);
    const stalled = mustMention(text, [seed.stalledName], 1);
    if (!stalled.pass) return { pass: false, detail: `stalled deal "${seed.stalledName}" not identified` };
    return { pass: true, detail: `stalled deal identified` };
  },
  async cleanup(o, seed) {
    if (!o.notion) return;
    for (const id of seed.pageIds) await o.notion.archivePage(id);
  },
});

export const crmReconcileInboxL4 = defineScenario<CrmSeed>({
  id: 'crm.reconcile-inbox.L4',
  category: 'crm',
  level: 4,
  title: 'Reconcile the CRM against my inbox — flag contacts not in the system',
  requires: ['P2-loop', 'P3-adapter:notion', 'P3-adapter:gmail', 'P5-crosssite'],
  sites: ['notion', 'gmail'],
  goal: 'Compare who I have been emailing with this week against the contacts in the Notion CRM, and flag anyone we are talking to that is not in the system. Read-only.',
  mode: 'plan-approve',
  maxActions: 12,
  reps: 3,
  passRate: 0.66,
  async seed() {
    // TODO(P5): seed one Gmail thread from a contact deliberately absent from
    // the Notion DB; verify = that contact's name in the answer.
    return { pageIds: [], stalledName: '', freshNames: [] };
  },
  async verify() {
    return { pass: false, detail: 'blocked scenario — seed/verify land with P5' };
  },
  async cleanup() {},
});
