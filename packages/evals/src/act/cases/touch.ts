// Touch-family cases (layer A) — blocked on ACT-touch: today touch.tap is
// mis-wired to a mouse move and touch.swipe is a stub; neither dispatches
// Input.dispatchTouchEvent.

import { defineConformance } from '../actScenario.js';
import { fail, pass, rectCenter, rectOf, settledState } from './helpers.js';

const PAGE = 'touch.html';

export const touchCases = [
  defineConformance({
    id: 'primitives.touch-tap.L1',
    family: 'touch',
    title: 'touch.tap registers as a tap (click + touchstart)',
    requires: ['ACT-touch'],
    page: PAGE,
    async run(ctx) {
      const p = rectCenter(await rectOf(ctx, PAGE, 'tap-pad'));
      const r = await ctx.driver.verb(ctx.tabId, { kind: 'touch.tap', target: p });
      if (!r.ok) return fail(`touch.tap refused: ${r.resultText}`);
      const s = await settledState(ctx, PAGE);
      return Number(s.taps) >= 1 && Number(s.touchStarts) >= 1
        ? pass('tap produced touchstart + click')
        : fail(`taps=${String(s.taps)} touchStarts=${String(s.touchStarts)} — no real touch events`);
    },
  }),

  defineConformance({
    id: 'primitives.touch-swipe.L1',
    family: 'touch',
    title: 'touch.swipe scrolls a horizontal strip',
    requires: ['ACT-touch'],
    page: PAGE,
    async run(ctx) {
      const r = await rectOf(ctx, PAGE, 'swipe-strip');
      const y = Math.round(r.y + r.h / 2);
      const res = await ctx.driver.verb(ctx.tabId, {
        kind: 'touch.swipe',
        from: { x: r.x + r.w - 10, y },
        to: { x: r.x + 10, y },
        durationMs: 400,
      });
      if (!res.ok) return fail(`touch.swipe refused: ${res.resultText}`);
      const s = await settledState(ctx, PAGE);
      return Number(s.swipeLeft) > 100 ? pass(`strip swiped to ${String(s.swipeLeft)}`) : fail(`swipeLeft=${String(s.swipeLeft)}`);
    },
  }),
];
