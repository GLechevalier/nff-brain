// `nff-brain agent` — submit and steer web-agent runs from the terminal, via
// the /v1/admin/agent/* routes. The run is ATTRIBUTED to a paired extension
// client and executed by that browser's service worker; this command never
// performs an action itself. Permanent power-user surface, and the drive path
// the eval harness uses (it can never hold the extension's bearer token).
//
//   nff-brain agent goal "<text>" [--max-actions N] [--auto] [--client id] [--model m]
//   nff-brain agent status [--run id] [--json]
//   nff-brain agent approve <runId>
//   nff-brain agent reject <runId>
//   nff-brain agent stop <runId>

import type { WebAgentRun } from '@nff-brain/core';
import { fail, flagNum, flagStr, parseArgs } from '../util.js';
import { admin } from './adminHttp.js';

function summarize(run: WebAgentRun): string {
  const lines = [
    `${run.id}  [${run.phase}]  client ${run.clientId}`,
    `  goal: ${run.goal}`,
    `  actions ${run.actionsTaken}/${run.maxActions}  history ${run.history.length}  updated ${run.updatedAt}`,
  ];
  if (run.plan) {
    lines.push(`  plan (${run.plan.site}): criteria "${run.plan.criteria}"`);
    for (const s of run.plan.steps) lines.push(`    ${s.id}  ${s.verb}  ${s.summary}`);
  }
  if (run.error) lines.push(`  error: ${run.error}`);
  return lines.join('\n');
}

export async function cmdAgent(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const [sub, ...rest] = args.positional;

  switch (sub) {
    case 'goal': {
      const goal = rest.join(' ').trim();
      if (!goal) fail('usage: nff-brain agent goal "<text>" [--max-actions N] [--auto] [--client id]');
      const { runId, clientId } = await admin<{ runId: string; clientId: string }>({
        path: '/v1/admin/agent/goal',
        body: {
          goal,
          maxActions: flagNum(args, 'max-actions'),
          autoApprove: args.flags.auto === true,
          client: flagStr(args, 'client'),
          model: flagStr(args, 'model'),
        },
      });
      process.stdout.write(
        `run ${runId} planning (executes in paired client ${clientId})\n` +
          `watch it: nff-brain agent status --run ${runId}\n`,
      );
      return;
    }

    case 'status': {
      const runId = flagStr(args, 'run');
      const res = await admin<{ run: WebAgentRun | null; recent?: WebAgentRun[] }>({
        path: runId ? `/v1/admin/agent/status?run=${encodeURIComponent(runId)}` : '/v1/admin/agent/status',
        method: 'GET',
      });
      if (args.flags.json === true) {
        process.stdout.write(JSON.stringify(res, null, 2) + '\n');
        return;
      }
      if (res.run) {
        process.stdout.write(summarize(res.run) + '\n');
      } else {
        process.stdout.write(runId ? `no run ${runId}\n` : 'no active run\n');
      }
      if (!runId && res.recent && res.recent.length > 0) {
        process.stdout.write('recent:\n');
        for (const r of res.recent.slice(0, 5)) {
          process.stdout.write(`  ${r.id}  [${r.phase}]  ${r.goal.slice(0, 60)}\n`);
        }
      }
      return;
    }

    case 'approve':
    case 'reject':
    case 'stop': {
      const runId = rest[0] ?? flagStr(args, 'run');
      if (!runId) fail(`usage: nff-brain agent ${sub} <runId>`);
      const res = await admin<{ run?: WebAgentRun | null }>({
        path: `/v1/admin/agent/${sub}`,
        body: { runId },
      });
      if (sub === 'stop') {
        process.stdout.write(`stop requested for ${runId}\n`);
      } else if (res.run) {
        process.stdout.write(`${runId} → ${res.run.phase}\n`);
      } else {
        process.stdout.write(`no active run ${runId} (already finished, or wrong id)\n`);
      }
      return;
    }

    default:
      fail('usage: nff-brain agent goal|status|approve|reject|stop — see `nff-brain help`');
  }
}
