// `nff-brain clips` — inspect the browser-capture queue, and drain it on
// demand. The drain normally runs inside the SessionEnd hook; --drain is the
// manual path that needs no Claude session, which is also how the loop is
// verified end-to-end (clip in Chrome → drain → node in the brain).

import {
  clipQueueStats,
  readClips,
  resolveBrainPaths,
  type ClipRecord,
} from '@nff-brain/core';
import { drainClips } from '../clipDrain.js';
import { flagStr, parseArgs } from '../util.js';

function describe(c: ClipRecord): string {
  const when = c.at.slice(0, 16).replace('T', ' ');
  const what = c.text ? c.text.replace(/\s+/g, ' ').slice(0, 70) : (c.url ?? '');
  const from = c.url && c.text ? `  (${c.url.slice(0, 60)})` : '';
  return `  ${when}  [${c.kind}] ${what}${from}`;
}

export async function cmdClips(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const paths = resolveBrainPaths();

  if (args.flags.drain === true) {
    const result = await drainClips(paths, { model: flagStr(args, 'model') });
    const bits = [
      `${result.processed} clip(s) processed`,
      `${result.created.length} node(s) created`,
      ...(result.refined.length ? [`${result.refined.length} refined`] : []),
      ...(result.leftQueued ? [`${result.leftQueued} left queued`] : []),
    ];
    console.log(bits.join(', '));
    for (const id of result.created) console.log(`  + ${id}`);
    return;
  }

  const targets: Array<{ label: string; brainPath: string }> = [
    { label: 'global ', brainPath: paths.global },
    ...(paths.project !== paths.global ? [{ label: 'project', brainPath: paths.project }] : []),
  ];
  let pendingTotal = 0;
  for (const t of targets) {
    const stats = clipQueueStats(t.brainPath);
    pendingTotal += stats.pending;
    const full = stats.full ? '  ⚠ FULL — captures are being refused' : '';
    console.log(`${t.label}  ${stats.pending} pending${full}`);
    for (const c of readClips(t.brainPath, 20)) console.log(describe(c));
  }
  if (pendingTotal > 0) {
    console.log(`\nrun \`nff-brain clips --drain\` to mint nodes now (otherwise the next session's SessionEnd drains them)`);
  }
}
