// Media & downloads conformance cases (layer A).

import { defineConformance } from '../actScenario.js';
import { clickByName, fail, focusByName, pass, press, settledState, sleep } from './helpers.js';

const PAGE = 'media.html';

export const mediaCases = [
  defineConformance({
    id: 'primitives.media-controls.L1',
    family: 'media',
    title: 'Play / pause / seek / volume on a custom player',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'play', { role: 'button' });
      await sleep(1600);
      const playing = await settledState(ctx, PAGE);
      if (playing.playing !== true || Number(playing.pos) < 1) {
        return fail(`after play: playing=${String(playing.playing)} pos=${String(playing.pos)}`);
      }
      await clickByName(ctx, 'pause', { role: 'button' });
      const paused = await settledState(ctx, PAGE);
      if (paused.playing !== false) return fail('pause did not stop playback');
      await clickByName(ctx, 'seek to 30s', { role: 'button' });
      const sought = await settledState(ctx, PAGE);
      if (Number(sought.pos) !== 30) return fail(`seek landed at ${String(sought.pos)}s`);
      await focusByName(ctx, 'volume');
      await press(ctx, 'ArrowRight', { count: 3 });
      const s = await settledState(ctx, PAGE);
      return Number(s.volume) > 50
        ? pass(`play/pause/seek ok, volume ${String(s.volume)}`)
        : fail(`volume stuck at ${String(s.volume)}`);
    },
  }),

  defineConformance({
    id: 'primitives.media-download-link.L1',
    family: 'media',
    title: 'Clicking a download link fetches the asset (server-ledger oracle)',
    requires: ['ACT-harness', 'ACT-engine'],
    page: PAGE,
    async run(ctx) {
      await clickByName(ctx, 'download report.txt');
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (ctx.fixtures.ledger.assetRequests.some((r) => r.run === ctx.nonce && r.pathname.includes('report.txt'))) {
          return pass('download request hit the server');
        }
        await sleep(300);
      }
      return fail('no /bench/dl/report.txt request arrived within 8s');
    },
  }),

  defineConformance({
    id: 'primitives.media-downloads-api.L1',
    family: 'media',
    title: 'Observe the completed download via chrome.downloads',
    requires: ['ACT-downloads'],
    page: PAGE,
    // run() lands with the ACT-downloads capability (needs the downloads
    // permission plus a driver command to query chrome.downloads).
  }),
];
