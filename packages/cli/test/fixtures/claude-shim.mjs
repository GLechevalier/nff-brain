// Mock `claude` binary for e2e tests: reads the prompt from stdin and answers
// with canned JSON depending on which nff-brain prompt it recognizes.
// SHIM_MODE=hang sleeps forever (for the fail-open timeout test).
//
// With `--input-format stream-json` in argv it instead mimics the persistent
// stream-json conversation (ClaudeSession): one `result` line per stdin user
// line, embedding process.pid and a turn counter so tests can PROVE the same
// process answered successive turns. SHIM_MODE=hang never answers;
// SHIM_MODE=die-after-1 exits after the first result (the respawn test).

if (process.argv.includes('--input-format')) {
  let turn = 0;
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'shim' }) + '\n');
  process.stdin.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      if (process.env.SHIM_MODE === 'hang') continue; // swallow the turn, never answer
      turn += 1;
      let userText = '';
      try {
        userText = JSON.parse(line).message.content[0].text ?? '';
      } catch {
        /* result still answers, with an empty echo */
      }
      // Echo a slice of the user text so tests can tell bootstrap from delta turns.
      const result = `pid:${process.pid} turn:${turn} saw:${userText.slice(0, 60)}`;
      process.stdout.write(
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: result }] } }) + '\n',
      );
      process.stdout.write(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result, session_id: 'shim' }) + '\n',
      );
      if (process.env.SHIM_MODE === 'die-after-1') process.exit(0);
    }
  });
  // Keep running until stdin closes (the parent owns our lifetime).
  process.stdin.on('end', () => process.exit(0));
} else {
  legacyOneShot();
}

function legacyOneShot() {
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
  } else if (prompt.includes('workflow distiller')) {
    // trace distill (paired /v1/trace): one generalized step with a param.
    process.stdout.write(
      JSON.stringify({
        intent: 'Search for a topic and open the first result',
        params: [{ name: 'query', description: 'what to search for', example: 'robotics engineer', required: true }],
        steps: [
          { intent: 'search for {query}', verbs: ['type', 'click'], params: ['query'], success: 'results are shown' },
        ],
        successCriteria: 'the first result is open',
      }),
    );
  } else if (prompt.includes('brain chat assistant')) {
    // chat: plain prose, deliberately NOT JSON — echoes back a marker the
    // route test can assert on without depending on exact wording.
    process.stdout.write('Here is what your notes say, in plain prose: loopback only for the OAuth callback url.');
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
}
