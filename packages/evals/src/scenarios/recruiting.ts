// Recruiting ladder — decomposes onto the email/calendar primitives, so it
// rides the gmail adapter and unlocks late. Registered now for the scorecard.

import { defineScenario } from '../scenario.js';
import type { Oracles } from '../oracles/types.js';
import { mustMention, runAnswerText } from './helpers.js';

interface RecruitingSeed {
  ids: string[];
  applicants: string[];
}

export const recruitingSummarizeL1 = defineScenario<RecruitingSeed>({
  id: 'recruiting.summarize.L1',
  category: 'recruiting',
  level: 1,
  title: 'Summarize the new applicants for a role',
  requires: ['P2-loop', 'P3-adapter:gmail'],
  sites: ['gmail'],
  goal: 'Open Gmail and summarize today\'s job applications for the firmware engineer role — who applied and their headline experience. Read-only.',
  mode: 'plan-approve',
  maxActions: 8,
  reps: 3,
  passRate: 0.66,
  async seed(o: Oracles, nonce: string): Promise<RecruitingSeed> {
    const gmail = o.gmail!;
    const applicants = ['Nadia Karim', 'Tom Okafor', 'Lea Fischer'];
    const bodies = [
      `Application for Firmware Engineer — ${applicants[0]}. 6 years ESP32/STM32, led OTA pipeline at a fleet startup. ${nonce}`,
      `Firmware Engineer application — ${applicants[1]}. Embedded Linux + Zephyr, 4 years, side projects in Rust. ${nonce}`,
      `Re: Firmware role — ${applicants[2]}. New grad, strong FPGA coursework, internship at an automotive supplier. ${nonce}`,
    ];
    const msgs = await Promise.all(
      bodies.map((body, i) =>
        gmail.insertMessage({ from: `applicant${i}@example.com`, subject: `Firmware Engineer application ${nonce}-${i}`, body }),
      ),
    );
    return { ids: msgs.map((m) => m.id), applicants };
  },
  async verify(_o, run, seed) {
    return mustMention(runAnswerText(run), seed.applicants, 2);
  },
  async cleanup(o, seed) {
    if (!o.gmail) return;
    for (const id of seed.ids) await o.gmail.deleteMessage(id);
  },
});
