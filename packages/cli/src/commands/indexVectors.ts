import {
  EMBED_DIM,
  embedBatch,
  embedError,
  embedModel,
  indexBrain,
  loadBrain,
  loadVectors,
  resolveBrainPaths,
  resolveTransformers,
  vectorPlan,
} from '@nff-brain/core';
import type { BrainFile } from '@nff-brain/core';
import { parseArgs } from '../util.js';

// `nff-brain index [--global] [--all] [--force] [--check] [--json]`
//
// Brings the vector sidecar up to date. Deliberately EXITS 0 when the optional
// runtime is absent: this command shows up in scripts and in the distill tail,
// and semantic search being off is a normal state, not a failure.

interface Target {
  label: string;
  path: string;
  brain: BrainFile | null;
}

function targets(args: ReturnType<typeof parseArgs>): Target[] {
  const paths = resolveBrainPaths(process.cwd());
  const load = (p: string): BrainFile | null => {
    try {
      return loadBrain(p);
    } catch {
      return null;
    }
  };
  const project: Target = { label: 'project', path: paths.project, brain: load(paths.project) };
  const global: Target = { label: 'global', path: paths.global, brain: load(paths.global) };
  if (args.flags.all === true) return [project, global];
  return [args.flags.global === true ? global : project];
}

export async function cmdIndex(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const model = embedModel();
  const json = args.flags.json === true;
  const list = targets(args).filter((t) => t.brain !== null);

  if (list.length === 0) {
    if (json) console.log(JSON.stringify({ ok: true, semantic: false, reason: 'no brain file' }));
    else console.log('no brain file here — run `nff-brain init`');
    return;
  }

  // --check never loads the model: it is what doctor-style scripting uses.
  if (args.flags.check === true) {
    const report = list.map((t) => {
      const plan = vectorPlan(t.brain!, loadVectors(t.path), model);
      return { target: t.label, ...counts(plan) };
    });
    if (json) console.log(JSON.stringify({ ok: true, model, targets: report }));
    else for (const r of report) console.log(`${r.target}: ${r.fresh} current, ${r.stale} stale, ${r.orphaned} orphaned`);
    return;
  }

  const rt = resolveTransformers();
  if (!rt.installed) {
    if (json) {
      console.log(JSON.stringify({ ok: true, semantic: false, reason: rt.detail ?? 'runtime not installed' }));
    } else {
      console.log('semantic search is not enabled — nothing to index.');
      console.log('search still works (lexical ranking); enable embeddings with:');
      console.log('  nff-brain semantic install');
    }
    return; // exit 0 on purpose
  }

  const results: Record<string, unknown>[] = [];
  for (const t of list) {
    const started = Date.now();
    const res = await indexBrain(t.path, t.brain!, embedBatch, { model, dim: EMBED_DIM });
    const ms = Date.now() - started;
    results.push({ target: t.label, ...res, ms });
    if (json) continue;
    if (res.failed > 0 && res.embedded === 0) {
      console.log(`${t.label}: could not embed — ${embedError() ?? 'unknown error'}`);
      console.log('  search falls back to lexical ranking.');
      continue;
    }
    const bits = [`embedded ${res.embedded}`, `reused ${res.reused}`];
    if (res.pruned) bits.push(`pruned ${res.pruned}`);
    if (res.failed) bits.push(`failed ${res.failed}`);
    console.log(`${t.label}: ${bits.join(', ')} in ${(ms / 1000).toFixed(1)}s → ${t.path.replace(/brain\.json$/, 'vectors.json')}`);
  }
  if (json) console.log(JSON.stringify({ ok: true, semantic: true, model, targets: results }));
}

function counts(plan: { fresh: string[]; stale: string[]; orphaned: string[] }) {
  return { fresh: plan.fresh.length, stale: plan.stale.length, orphaned: plan.orphaned.length };
}
