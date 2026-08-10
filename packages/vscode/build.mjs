import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Extension host bundle (CJS, vscode external, core inlined).
const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: false,
  minify: !watch,
});

// Webview bundle (browser IIFE, React inlined).
const webviewCtx = await esbuild.context({
  entryPoints: ['webview/main.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  outfile: 'dist/webview.js',
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
