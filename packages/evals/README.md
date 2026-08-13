# @nff-brain/evals — real-account eval harness for the web agent

Eval-driven development: every corporate-task ladder level (email, calendar,
Slack, LinkedIn, CRM, recruiting, Drive) is a registered scenario from day
one. A scenario runs only when every tag in its `requires` is live in
`capabilities.json`; until then it reports **blocked** — the blocked→pass
transitions per capability flip are the progress metric. Full design:
`~/.claude/plans` plan "Web Agent: Corporate-Task Eval Suite + Capability Roadmap".

**Real accounts only** (user decision): dedicated test accounts on real Gmail,
Google Calendar/Drive, Slack, Notion, LinkedIn. No fixture pages. Ground truth
comes from each service's own API (the oracle layer), never from the DOM.

## Tiers

| Tier | Gate | LLM | Browser |
|---|---|---|---|
| 0 | always (CI) | none | none — `vitest run` unit/shape suites |
| 1 | always (CI) | claude-shim | none — `packages/cli/test/agentAdminHttp.test.ts` plays the extension |
| 2 | `RUN_BROWSER=1` | claude-shim | real extension + serve + real sites, read-only |
| 3 | `RUN_EVALS=1` | real local `claude` | everything real |
| 3-LI | `+ RUN_EVALS_LINKEDIN=1` | real | LinkedIn destructive scenarios, budgeted |

## One-time setup

1. **Accounts** (all dedicated, never personal): a Gmail account (covers
   Calendar + Drive), a free Slack workspace you own, a Notion workspace with a
   `Deals` database (`Name` title / `Stage` select / `Amount` number /
   `LastActivity` date), a **disposable** LinkedIn account (+ a warmed spare —
   ban risk is accepted, budgets only lower it).
2. `npm install` at the nff-brain root, then `npx playwright install chromium`.
3. `.env.evals` (gitignored — see `.env.evals.example`).
4. `npm run setup:google -w @nff-brain/evals` — mints `.auth/google.json`.
5. `npm run setup:login -w @nff-brain/evals` — headed browser on the eval
   profile; log in to every service by hand, close the window.
6. Build with the test manifest (promotes optional grants for unpacked load):
   PowerShell: `$env:NFF_BRAIN_TEST_MANIFEST='1'; npm run build` (then remove the var).
   `zip.mjs` refuses to package such a dist, so it cannot reach the store.

## Running

```
npm run evals -w @nff-brain/evals -- --list
$env:RUN_BROWSER='1'; npm run evals -w @nff-brain/evals -- --id linkedin.connect.L1   # P0 exit criterion
$env:RUN_EVALS='1';  npm run evals -w @nff-brain/evals                                # nightly scorecard
```

Scorecards land in `artifacts/<stamp>/scorecard.{md,json}`; plan snapshots and
humanReview screenshots land beside them. Budgets/cooldowns persist in
`state/budgets.json` (LinkedIn: 5 connect-units/day, 45-min cooldown) — the
runner marks over-budget scenarios `skipped-budget` rather than spending.

## Architecture notes

- Goals are submitted over `/v1/admin/agent/*` (adminToken, loopback, no
  Origin) and ATTRIBUTED to the paired extension client — the harness can
  never hold the extension's bearer token, and the DevTools panel (the human
  UI) is undrivable by design (`chrome.devtools.*` only exists in real F12).
- serve runs as a subprocess of the runner with `NFF_BRAIN_HOME` pointing at
  `state/brain-home` — isolated state WITHOUT redirecting `HOME`, which would
  sever the spawned `claude` CLI's auth in tier 3.
- `state/brain-home` and `.profiles/` persist on purpose: pairing and site
  logins must survive between runs.
- Playwright drives ONLY extension pages (popup pairing, SW messages) and
  takes screenshots; it never touches the sites the agent is being tested on.
