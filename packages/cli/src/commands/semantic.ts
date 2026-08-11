import {
  PACKAGE_SPEC,
  embedAvailable,
  embedCacheDir,
  embedError,
  embedModel,
  embedQuery,
  installRuntime,
  resetEmbedder,
  resolveTransformers,
  uninstallRuntime,
} from '@nff-brain/core';
import { fail, flagStr, parseArgs } from '../util.js';

// `nff-brain semantic install | status | uninstall` — manages the OPTIONAL
// embedding runtime. See packages/core/src/semanticRuntime.ts for why it lives
// in ~/.nff-brain/runtime instead of being a package dependency.

export async function cmdSemantic(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const sub = args.positional[0] ?? 'status';
  switch (sub) {
    case 'status':
      return status();
    case 'install':
      return install(flagStr(args, 'spec') ?? PACKAGE_SPEC);
    case 'uninstall':
      return uninstall();
    default:
      fail(`unknown subcommand "${sub}" — usage: nff-brain semantic [status|install|uninstall]`);
  }
}

async function status(): Promise<void> {
  const rt = resolveTransformers();
  console.log(`runtime dir : ${rt.dir}`);
  console.log(`model cache : ${embedCacheDir()}`);
  console.log(`model       : ${embedModel()}`);
  if (!rt.installed) {
    console.log('status      : not installed (search is lexical-only)');
    if (rt.detail) console.log(`detail      : ${rt.detail}`);
    console.log('\nenable it with:  nff-brain semantic install');
    return;
  }
  console.log(`package     : ${rt.entry}${rt.version ? ` (v${rt.version})` : ''}`);
  process.stdout.write('status      : loading model… ');
  const ok = await embedAvailable();
  console.log(ok ? 'ready' : 'INSTALLED BUT UNUSABLE');
  if (!ok) {
    console.log(`detail      : ${embedError() ?? 'unknown error'}`);
    console.log('search falls back to lexical ranking — nothing is broken.');
  }
}

async function install(spec: string): Promise<void> {
  const rt = resolveTransformers();
  console.log(`installing ${spec} into ${rt.dir}`);
  console.log('this is a one-time ~400 MB download (the ONNX runtime ships native');
  console.log('prebuilt binaries) plus ~33 MB of model weights on first use.\n');

  const res = installRuntime({ spec });
  // Echo the exact command: on Windows this is where paths with spaces and
  // odd npm prefixes bite, and the user needs to be able to run it by hand.
  console.log(`$ ${res.command}`);
  if (!res.ok) {
    if (res.output) console.error(res.output);
    fail('npm install failed — see the command above; semantic search stays off');
  }
  console.log('runtime installed.');

  // Prefetch the weights so this is the ONLY moment that touches the network.
  // Force remote on for the fetch even if the user set NFF_BRAIN_EMBED_OFFLINE.
  resetEmbedder();
  process.stdout.write('fetching model weights… ');
  const prev = process.env.NFF_BRAIN_EMBED_OFFLINE;
  delete process.env.NFF_BRAIN_EMBED_OFFLINE;
  const v = await embedQuery('warm the model cache');
  if (prev !== undefined) process.env.NFF_BRAIN_EMBED_OFFLINE = prev;

  if (!v) {
    console.log('failed');
    console.error(`  ${embedError() ?? 'unknown error'}`);
    fail('the runtime installed but the model would not load — search stays lexical');
  }
  console.log(`ok (${embedModel()}, ${v.length}d)`);
  console.log('\nnow run:  nff-brain index');
}

function uninstall(): void {
  const removed = uninstallRuntime();
  console.log(
    removed
      ? 'semantic runtime removed — search is lexical-only again.'
      : 'nothing to remove (no runtime installed).',
  );
  console.log(`model weights left in ${embedCacheDir()} — delete that dir to reclaim the space.`);
}
