// Mock `claude` binary for e2e tests: reads the prompt from stdin and answers
// with canned JSON depending on which nff-brain prompt it recognizes.
// SHIM_MODE=hang sleeps forever (for the fail-open timeout test).

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (prompt += d));
process.stdin.on('end', () => {
  if (process.env.SHIM_MODE === 'hang') {
    setTimeout(() => {}, 600_000); // never answers
    return;
  }
  if (prompt.includes('memory architect')) {
    // init: split CLAUDE.md into nodes
    process.stdout.write(
      JSON.stringify({
        nodes: [
          { id: 'build-rules', title: 'Build rules', category: 'rules', content: 'Run npm run build before committing because CI enforces it.' },
          { id: 'deploy-procedure', title: 'Deploy procedure', category: 'strategy', content: 'When deploying, build one service at a time because full builds crash Docker.' },
          { id: 'api-conventions', title: 'API conventions', category: 'analysis', content: 'API imports must carry .js extensions because the dashboard uses ESM.' },
        ],
        edges: [
          { from: 'build-rules', to: 'deploy-procedure', strength: 0.7 },
        ],
      }),
    );
  } else if (prompt.includes('memory distiller')) {
    // distill: one lesson from the session
    process.stdout.write(
      JSON.stringify({
        nodes: [
          { id: 'login-cookie-fix', title: 'Login cookie fix', category: 'rules', content: 'When login breaks silently, check the http-only cookie flag first because the SPA cannot read it.' },
        ],
        edges: [{ from: 'login-cookie-fix', to: 'build-rules', strength: 0.6 }],
      }),
    );
  } else {
    process.stdout.write('{"nodes":[],"edges":[]}');
  }
});
