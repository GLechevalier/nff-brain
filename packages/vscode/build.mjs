import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// The optional embedding runtime is installed on demand into
// ~/.nff-brain/runtime and resolved at runtime — never bundled. This matters
// most for the extension bundle: it is CJS, and esbuild rewrites unanalyzable
// import() in CJS output into a require() shim that cannot load an ESM-only
// package. embed.ts hides the import behind new Function; this is belt-and-
// braces, and e2e.test.ts asserts the built artifacts stay clean.
const SEMANTIC_RUNTIME = ['@huggingface/transformers'];

// Extension host bundle (CJS, vscode external, core inlined).
const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode', ...SEMANTIC_RUNTIME],
  sourcemap: false,
  minify: !watch,
});

// Webview bundle (browser IIFE, React inlined). Nothing node-only may reach
// this bundle — see packages/core/test/webviewImports.test.ts.
const webviewCtx = await esbuild.context({
  entryPoints: ['webview/main.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  outfile: 'dist/webview.js',
  external: SEMANTIC_RUNTIME,
  sourcemap: false,
  minify: !watch,
  define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.css': 'text' },
});

if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  console.log('watching…');
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  console.log('built dist/extension.js + dist/webview.js');
}
