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
  } else if (prompt.includes('memory archaeologist')) {
    // import: mine a past session. Keyed on a marker planted in the synthetic
    // transcript so different sessions answer differently — that lets the e2e
    // assert the cross-session cluster boost and the low-confidence path.
    const shared = {
      title: 'Retry renameSync on Windows EPERM',
      content: 'Defender briefly locks the destination, so the atomic save must retry the rename.',
      confidence: 0.5,
    };
    if (prompt.includes('MARKER-ALPHA')) {
      process.stdout.write(
        JSON.stringify({
          memories: [shared],
          decisions: [
            { title: 'Bundle the CLI with tsup', content: 'Rollup needed hand-written externals config, tsup does not.', confidence: 0.8 },
          ],
          preferences: [],
          tasks: [{ title: 'Eyeball the sidebar in VS Code', content: 'Implemented but never visually confirmed.', confidence: 0.3 }],
          failures: [],
        }),
      );
    } else if (prompt.includes('MARKER-BETA')) {
      // Same lesson, different wording — must cluster with ALPHA's and boost.
      process.stdout.write(
        JSON.stringify({
          memories: [
            { ...shared, title: 'Retry renameSync when Windows throws EPERM' },
          ],
          decisions: [],
          preferences: [
            { title: 'Prefers terse commit messages', content: 'Asks for one-line subjects with no body unless the change is subtle.', confidence: 0.7 },
          ],
          tasks: [],
          failures: [],
        }),
      );
    } else {
      process.stdout.write('{"memories":[],"decisions":[],"preferences":[],"tasks":[],"failures":[]}');
    }
  } else if (prompt.includes('memory clipper')) {
    // clip drain: named category arrays, entries addressed by clip INDEX.
    // Index 0 → a strategy node, index 1 → a rules node; anything past that is
    // deliberately omitted (the "worthless clip" path — still ledgered).
    process.stdout.write(
      JSON.stringify({
        strategy: [
          { i: 0, title: 'MQTT keepalive default', content: 'Brokers drop idle clients at 90s, so keepalive must be under 60.' },
        ],
        rules: [
          { i: 1, title: 'CORS preflight before auth', content: 'Answer OPTIONS before checking bearer tokens or the browser never sends them.' },
        ],
        duplicate: [],
      }),
    );
  } else if (prompt.includes('web agent planner')) {
    // web agent: one searchPeople step then one evaluateCards step.
    process.stdout.write(
      JSON.stringify({
        steps: [
          { summary: 'Search LinkedIn for robotics engineers', verb: 'searchPeople', args: { query: 'robotics engineer' } },
          { summary: 'Judge the results against the goal', verb: 'evaluateCards', args: {} },
        ],
        criteria: 'robotics engineer at a Series A startup',
      }),
    );
  } else if (prompt.includes("web agent's judgment call")) {
    // web agent filter: always match card #0 — deterministic for a single-page test.
    process.stdout.write(JSON.stringify({ matches: [{ i: 0, reason: 'matches the criteria' }] }));
  } else if (prompt.includes("web agent's list-write field mapper")) {
    // web agent list-write: map whatever name was read straight through.
    const m = /"name":"([^"]*)"/.exec(prompt);
    process.stdout.write(JSON.stringify({ args: { name: m?.[1] ?? 'Unknown' } }));
  } else if (prompt.includes('graph explainer')) {
    // ingest-graphify: batched intent explanations keyed by brain node id
    process.stdout.write(
      JSON.stringify({
        explanations: {
          'gf-area-auth-layer': 'Owns user authentication end to end; exists so session logic lives in one place.',
          'gf-flow-login-flow': 'The path a login request takes from endpoint to session storage.',
        },
      }),
    );
  } else {
    process.stdout.write('{"nodes":[],"edges":[]}');
  }
});
