import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CATEGORIES,
  CATEGORY_HINTS,
  NFF_PROMPT_MARKERS,
  applyDelta,
  discoverSessions,
  extractJson,
  loadBrain,
  mutateBrain,
  resolveBrainPaths,
  runClaude,
  slug,
  upsertEdge,
  upsertNode,
  type BrainFile,
  type BrainNode,
  type RawDelta,
} from '@nff-brain/core';
import { flagStr, parseArgs, type Args } from '../util.js';
import { cmdImport } from './import.js';
import { cmdInstallHooks } from './hooks.js';

// `nff-brain init` — create the project brain, seeded from CLAUDE.md/AGENTS.md
// when they exist (one claude -p call splits the flat memory doc into graph
// nodes). Idempotent: re-running refines existing nodes instead of clobbering.

const MEMORY_DOC_CANDIDATES = ['CLAUDE.md', 'AGENTS.md', path.join('.claude', 'CLAUDE.md')];
const MAX_DOC_CHARS = 12_000;
const MAX_INIT_NODES = 12;

function buildInitPrompt(docText: string, known: BrainNode[], hubId: string): string {
  const knownList = known.length
    ? known.map((n) => `- id="${n.id}" [${n.category}] ${n.title}`).join('\n')
    : '(none yet)';
  return [
    `${NFF_PROMPT_MARKERS.architect} for a coding agent working on this project.`,
    `Below is the project's flat memory document (CLAUDE.md / AGENTS.md). Split it into a`,
    `knowledge graph of durable, reusable knowledge: conventions, procedures, gotchas,`,
    `architecture facts, rules. Group related guidance into one node; drop filler.`,
    ``,
    `Return STRICT JSON only (no prose, no code fence) of shape:`,
    `{"nodes":[{"id","title","category","content"}],"edges":[{"from","to","strength"}]}`,
    `Rules:`,
    `- category must be one of: ${CATEGORIES.join(' | ')}`,
    ...CATEGORIES.map((c) => `    ${c} — ${CATEGORY_HINTS[c]}`),
    `- content = actionable guidance in 1-4 sentences, self-contained.`,
    `- To REFINE existing knowledge, reuse that node's exact id (see KNOWN NODES). Otherwise`,
    `  invent a short kebab-case id. At most ${MAX_INIT_NODES} nodes total.`,
    `- edges connect related node ids (you may reference "${hubId}", the project hub);`,
    `  strength 0..1 (0.9 = tightly coupled, 0.5 = loosely related).`,
    `- Aim for every node to have at least one edge.`,
    ``,
    `KNOWN NODES (already in the brain):`,
    knownList,
    ``,
    `MEMORY DOCUMENT:`,
    docText.slice(0, MAX_DOC_CHARS),
  ].join('\n');
}

export async function cmdInit(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const paths = resolveBrainPaths(process.cwd());
  const target = args.flags.global === true ? paths.global : paths.project;
  const projectName = path.basename(paths.workspaceRoot);
  const hubId = slug(projectName) || 'project';

  // 1. Ensure the brain exists with its hub node (pinned center of the board).
  mutateBrain(target, (brain: BrainFile) => {
    // Specifically a SEED core node. The looser `category === 'core'` test was
    // also satisfied by graphify's "god" nodes, so running `ingest-graphify`
    // before `init` meant the project never got a hub at all.
    if (!brain.nodes.some((n) => n.category === 'core' && n.origin === 'seed')) {
      upsertNode(brain, {
        id: hubId,
        title: projectName,
        category: 'core',
        content: `Central hub for ${projectName} knowledge. Connected nodes hold this project's conventions, procedures, and gotchas.`,
        color: '#00ffcc',
        x: 400,
        y: 300,
        size: 32,
        origin: 'seed',
        lastUpdated: new Date().toISOString(),
        recallCount: 0,
      });
    }
  });
  console.log(`brain: ${target}`);

  // 2. Ingest CLAUDE.md / AGENTS.md via claude -p, when present.
  const docs: string[] = [];
  for (const rel of MEMORY_DOC_CANDIDATES) {
    const p = path.join(paths.workspaceRoot, rel);
    try {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) docs.push(`### ${rel}\n${text}`);
    } catch {
      /* absent — fine */
    }
  }

  if (docs.length === 0) {
    console.log('no CLAUDE.md / AGENTS.md found — starting with an empty graph.');
  } else {
    console.log(`ingesting ${docs.length} memory doc(s) via claude -p…`);
    const snapshot = loadBrain(target)!;
    const prompt = buildInitPrompt(docs.join('\n\n'), snapshot.nodes, hubId);
    try {
      const raw = await runClaude(prompt, { model: flagStr(args, 'model'), timeoutMs: 120_000 });
      const delta = extractJson<RawDelta>(raw);
      if (!delta) {
        console.error('claude returned no parseable JSON — graph left as-is.');
      } else {
        const written = mutateBrain(target, (brain) => {
          // CLAUDE.md content is user-curated → seed origin (never auto-evicted).
          const written = applyDelta(brain, delta, { maxNewNodes: MAX_INIT_NODES, origin: 'seed' });
          // Orphans still connect to the hub so the graph reads as one structure.
          for (const id of written) {
            const touched = brain.edges.some((e) => e.from === id || e.to === id);
            if (!touched && id !== hubId) upsertEdge(brain, { from: id, to: hubId, strength: 0.4 });
          }
          return written;
        });
        console.log(`created/refined ${written.size} node(s): ${[...written].join(', ')}`);
      }
    } catch (err) {
      console.error(`claude -p failed (${err instanceof Error ? err.message : String(err)}) — graph left as-is.`);
    }
  }

  // 3. Optionally wire the hooks in the same run.
  if (args.flags.hooks === true) {
    await cmdInstallHooks(args.flags.global === true ? ['--global'] : []);
  } else {
    console.log(`next: nff-brain install-hooks   (wires SessionStart recall + SessionEnd distill)`);
  }

  // 4. Past Claude Code sessions are the fastest path to a brain worth having:
  // an empty graph only fills up as NEW sessions end, so a fresh install feels
  // useless for days while the history to fix that is already on disk.
  await offerHistoryImport(args);
}

async function offerHistoryImport(args: Args): Promise<void> {
  let available = 0;
  try {
    // One bounded probe — cheap enough to run on every init.
    available = discoverSessions({ cwd: process.cwd(), limit: 1 }).sessions.length;
  } catch {
    return; // history discovery must never break init
  }
  if (available === 0) return;

  if (args.flags.import === true) {
    // --no-interactive: init has already printed a wall of output; dropping
    // into the wizard mid-init would be jarring, and --import means "just do it".
    await cmdImport(args.flags.global === true ? ['--global', '--no-interactive'] : ['--no-interactive']);
    return;
  }
  console.log('');
  console.log('past Claude Code sessions were found for this folder.');
  console.log('turn them into memories now:   nff-brain import');
}
