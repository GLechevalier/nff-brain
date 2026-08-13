import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';

const watch = process.argv.includes('--watch');
const OUT = 'dist';

// dist/ IS the load-unpacked directory and IS the contents of the store zip, so
// manifest.json must sit at its root and nothing else may be in there. Source
// never lands in dist, so there is no .vscodeignore analogue to maintain.
const STATIC = [
  ['manifest.json', 'manifest.json'],
  ['popup/popup.html', 'popup.html'],
  ['popup/popup.css', 'popup.css'],
  ['devtools/devtools.html', 'devtools.html'],
  ['devtools/panel.html', 'panel.html'],
  ['devtools/panel.css', 'panel.css'],
  ['options/options.html', 'options.html'],
  ['options/options.css', 'options.css'],
  ['sidepanel/sidepanel.html', 'sidepanel.html'],
  ['sidepanel/sidepanel.css', 'sidepanel.css'],
  ['icons', 'icons'],
];

function copyStatic() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [from, to] of STATIC) {
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(OUT, to), { recursive: true });
  }
  writeTestManifest();
}

/**
 * NFF_BRAIN_TEST_MANIFEST=1 — the eval harness's manifest variant. Promotes
 * BOTH optional lists to install-time grants (host_permissions gets the
 * optional_host_permissions array; optional_permissions fold into
 * permissions), because an unpacked load auto-grants install-time permissions
 * while Chrome's native optional-permission prompt cannot be driven by any
 * automation. dist/ then differs from the production manifest in EXACTLY
 * those two keys — pinned by manifest.test.ts. Never ship this variant: the
 * store zip must always be built without the env var.
 */
function writeTestManifest() {
  if (process.env.NFF_BRAIN_TEST_MANIFEST !== '1') return;
  const p = path.join(OUT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  m.host_permissions = m.optional_host_permissions ?? [];
  m.permissions = [...m.permissions, ...(m.optional_permissions ?? [])];
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
  console.log('NFF_BRAIN_TEST_MANIFEST=1 — dist/manifest.json promotes optional permissions (DO NOT SHIP)');
}

const common = {
  bundle: true,
  platform: 'browser',
  // Matches manifest.minimum_chrome_version — esbuild then refuses to emit
  // syntax that floor cannot parse, so the version claim is compiler-enforced.
  target: 'chrome116',
  // Classic worker + classic <script>: no "type": "module" in the manifest and
  // no ESM output. esbuild emits one self-contained IIFE with no runtime
  // imports, so module semantics would buy nothing.
  format: 'iife',
  // Resolve @nff-brain/core to its TypeScript sources rather than its published
  // dist/ — core's exports map gates src behind this condition. bundlePurity's
  // core-subpath allowlist reasons about source imports, so the bundles must
  // keep seeing source.
  conditions: ['nff-brain-source'],
  sourcemap: false,
  minify: !watch,
};

// One content-script bundle per recorder adapter; a new adapter is one line
// here plus its registry entry (src/recorderRegistry.ts scriptFile must match).
const CONTENT = [
  ['content/github.ts', 'rec-github.js'],
  ['content/linkedin.ts', 'rec-linkedin.js'],
  ['content/linkedinAgent.ts', 'rec-linkedin-agent.js'],
  // Record-and-automate: the generic task recorder, injected only while a
  // recording is active on a granted origin.
  ['content/traceRecorder.ts', 'rec-trace.js'],
];

const swCtx = await esbuild.context({ ...common, entryPoints: ['src/sw.ts'], outfile: `${OUT}/sw.js` });
const popupCtx = await esbuild.context({ ...common, entryPoints: ['popup/main.ts'], outfile: `${OUT}/popup.js` });
const devtoolsCtx = await esbuild.context({ ...common, entryPoints: ['devtools/devtools.ts'], outfile: `${OUT}/devtools.js` });
const panelCtx = await esbuild.context({ ...common, entryPoints: ['devtools/panel.ts'], outfile: `${OUT}/panel.js` });
const optionsCtx = await esbuild.context({ ...common, entryPoints: ['options/main.ts'], outfile: `${OUT}/options.js` });
const sidepanelCtx = await esbuild.context({ ...common, entryPoints: ['sidepanel/main.ts'], outfile: `${OUT}/sidepanel.js` });
const contentCtxs = await Promise.all(
  CONTENT.map(([entry, out]) => esbuild.context({ ...common, entryPoints: [entry], outfile: `${OUT}/${out}` })),
);
const contexts = [swCtx, popupCtx, devtoolsCtx, panelCtx, optionsCtx, sidepanelCtx, ...contentCtxs];

copyStatic();

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
  let timer;
  for (const [from] of STATIC) {
    if (!fs.existsSync(from)) continue;
    // Editors write files in bursts — debounce or a save fires copyStatic 4×.
    fs.watch(from, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(copyStatic, 50);
    });
  }
  console.log(`watching… load unpacked from ${path.resolve(OUT)}`);
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  console.log('built dist/sw.js + dist/popup.js + dist/devtools.js + dist/panel.js + dist/sidepanel.js + statics');
}
