import * as path from 'node:path';
import {
  applyHysteresis,
  appendActivity,
  appendSample,
  calibratedThresholds,
  loadBrain,
  MIN_SAMPLES_TO_CALIBRATE,
  localSettingsPath,
  mergeBrains,
  modelLadder,
  policyOptions,
  readModelState,
  resolveBrainPaths,
  scoreNovelty,
  writeModelRequest,
  writeModelSetting,
  writeModelState,
} from '@nff-brain/core';
import { flagStr, logToBrainDir, parseArgs, parseHookPayload, readStdin, type HookPayload } from '../util.js';

// `nff-brain novelty` — how new is a task relative to the brain, and which
// session model does that imply?
//
// Two faces:
//  - Interactive: explainability/debug. Prints the score, the picked model and
//    the contributing nodes; --json emits the raw NoveltyResult.
//  - `--stdin-hook` (UserPromptSubmit): re-scores against the ACTUAL prompt
//    text and updates .nff-brain/model-request.json — but only when the picked
//    model changed, so the extension doesn't retype /model every prompt.
//    SILENT on stdout (UserPromptSubmit stdout is injected into the session
//    context) and HARD FAIL-OPEN like recall: no LLM, always exit 0.

export async function cmdNovelty(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const isHook = args.flags['stdin-hook'] === true;

  if (isHook && process.env.NFF_BRAIN_SKIP === '1') return; // our own claude -p run

  let cwd = process.cwd();
  try {
    let payload: HookPayload = {};
    if (isHook) {
      payload = parseHookPayload(await readStdin());
      if (payload.cwd) cwd = payload.cwd;
    }
    const paths = resolveBrainPaths(cwd);

    let project = null;
    let global = null;
    try {
      project = loadBrain(paths.project);
    } catch (err) {
      if (!isHook) throw err;
      logToBrainDir(paths.project, 'last-recall.log', `novelty: project brain unreadable: ${String(err)}`);
    }
    try {
      global = loadBrain(paths.global);
    } catch (err) {
      if (!isHook) throw err;
      logToBrainDir(paths.project, 'last-recall.log', `novelty: global brain unreadable: ${String(err)}`);
    }
    const merged = mergeBrains(project, global);

    if (isHook) {
      const prompt = (payload.prompt ?? '').trim();
      if (!prompt || prompt.startsWith('/')) return; // nothing to judge / slash command
      // Cuts come from this brain's OWN score distribution once enough prompts
      // have been seen — static 0.35/0.7 means different things on a 10-node
      // brain and a 400-node one, and on a mature graph everything clusters
      // near the lower cut and the ladder stops discriminating.
      const { ladder, thresholds: staticCuts } = modelLadder();
      const cal = calibratedThresholds(paths.project, ladder.length, staticCuts);
      const nov = scoreNovelty(merged, prompt, { ladder, thresholds: cal.thresholds });
      // The per-prompt heartbeat for the graph webview: which nodes this
      // prompt made the brain think of. Emitted unconditionally (BEFORE the
      // model-unchanged early return) — the glow is not an auto-model feature.
      if (nov.top.length > 0) {
        appendActivity(paths.project, {
          kind: 'prompt',
          ids: nov.top.map((t) => t.id),
          sessionId: payload.session_id,
        });
      }
      // "ok", "yes", "go ahead" carry no opinion about the model — they only
      // LOOK novel because there is nothing in them to match. Hold whatever the
      // session is on rather than escalating on every continuation.
      if (!nov.hasSignal) return;

      // Record AFTER scoring, so a sample never influences its own decision.
      appendSample(paths.project, nov.novelty);

      // Per session, not per workspace: two Claude terminals in one folder each
      // need their own decision, and the streak below has to survive prompts.
      const key = payload.session_id ?? 'default';
      const state = readModelState(paths.project);
      const prev = state.sessions[key] ?? null;
      const { model, belowStreak } = applyHysteresis(
        prev,
        nov.novelty,
        nov.ladder,
        nov.thresholds,
        policyOptions(),
      );
      const ts = new Date().toISOString();
      // Written even when the tier is unchanged — otherwise the streak that
      // eventually justifies a downgrade can never accumulate.
      state.sessions[key] = { model, novelty: nov.novelty, belowStreak, ts };
      writeModelState(paths.project, state);

      if (prev?.model === model) return; // no change — don't retype /model
      writeModelRequest(paths.project, {
        version: 1,
        sessionId: payload.session_id,
        cwd: paths.workspaceRoot,
        model,
        novelty: nov.novelty,
        ts,
        source: 'prompt',
        top: nov.top,
      });

      // The actuator (opt-in via `install-hooks --apply-model`). Claude Code
      // binds the model at session CREATION and never re-reads it, so this can
      // only ever steer the NEXT session — nothing retiers a running one. The
      // request file above stays for the VS Code extension's terminal path.
      if (args.flags['apply-model'] === true) {
        try {
          writeModelSetting(localSettingsPath(paths.workspaceRoot), model);
        } catch (err) {
          // Malformed settings are refused rather than destroyed — log and move on.
          logToBrainDir(paths.project, 'last-recall.log', `novelty: model setting not applied: ${String(err)}`);
        }
      }
      return;
    }

    const query = flagStr(args, 'query') ?? args.positional.join(' ');
    if (!query.trim()) {
      console.error('nff-brain: novelty needs a query — `nff-brain novelty --query "the task"`');
      process.exit(1);
    }
    const { ladder, thresholds: staticCuts } = modelLadder();
    const cal = calibratedThresholds(paths.project, ladder.length, staticCuts);
    const nov = scoreNovelty(merged, query, { ladder, thresholds: cal.thresholds });
    if (args.flags.json === true) {
      process.stdout.write(JSON.stringify({ ...nov, calibrated: cal.calibrated, samples: cal.sampleCount }, null, 2) + '\n');
      return;
    }
    const cuts = nov.thresholds.map((t, i) => `<${t.toFixed(2)} → ${nov.ladder[i]}`).join(', ');
    console.log(`novelty  ${nov.novelty.toFixed(2)}  →  ${nov.model}`);
    console.log(`ladder   ${nov.ladder.join(' → ')}  (${cuts}, else ${nov.ladder[nov.ladder.length - 1]})`);
    console.log(
      cal.calibrated
        ? `cuts     calibrated from ${cal.sampleCount} observed prompts`
        : `cuts     static — ${cal.sampleCount}/${MIN_SAMPLES_TO_CALIBRATE} prompts observed so far`,
    );
    if (!nov.hasSignal) {
      const n = nov.signalTokens;
      console.log(`signal   ${n} token${n === 1 ? '' : 's'} — too little to judge; the hook would hold the current model`);
    }
    if (nov.top.length === 0) {
      console.log('anchors  none — nothing in the brain matches this query');
    } else {
      console.log('anchors');
      for (const t of nov.top) {
        console.log(
          `  ${t.id}  relevance=${t.score.toFixed(2)} strength=${t.strength.toFixed(2)} deg=${t.degree}  ${t.title}`,
        );
      }
    }
  } catch (err) {
    if (!isHook) throw err;
    logToBrainDir(path.join(cwd, '.nff-brain', 'brain.json'), 'last-recall.log', `novelty: ${String(err)}`);
  }
}
