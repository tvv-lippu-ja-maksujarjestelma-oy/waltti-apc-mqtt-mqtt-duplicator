# Native adapter validation checkpoint

Task: c3b2f03f-c0c2-4fee-8ade-1ce6a6705a9c. This is a staged candidate, not a release.

- Shared source imported through Git from canonical commit
  `f1422645c6fa930e615613227c4bb2e25b696423`, without merging application histories.
- The classifier keeps its full manifest/lock/transitive checks. Eligibility adds
  an optional required-check count; the default remains two for seed compatibility.
- Policy wiring tests replace the Mergify-only wiring tests with native workflow,
  executor, app-bound CI and write-token-confinement assertions. No application
  test, assertion, timeout or error handler was weakened.
- `node --test .github/dependency-policy/*.cases.cjs`: exercises the real local
  npm v2 lock shape, authenticated-trailer API fixtures and the original seed's
  historical signed grouped update fixture. Native tests cover ordinary AUTO,
  current pnupu approval, bot/foreign/stale/dismissed reviews, actual configured
  CI counts, missing/failing/pending/foreign/newer CI, head/base changes,
  mixed/transitive data, holds added after eligibility, pre-existing auto-merge,
  revocation failure, dispatch failure and trusted workflow/token wiring.
- Repository gate: `npm run check-and-build` (TypeScript, format, ESLint, Jest,
  compile). Dependencies use `npm ci --ignore-scripts` and a task-specific cache.
- Workflow validation: actionlint on changed workflows and SchemaStore GitHub
  workflow schema. These validate structure, not live GitHub authorization.
- All runs use task-owned checkouts and task-specific output directories outside
  Git. No production service, native merge or deploy was tested. No settings,
  apps, credentials, board state, PRs or external messages were changed.

Host adoption is still blocked. Both activation flags remain false. Read the
policy contract for exact required status/app binding, token and dispatch probes,
S1 ordinary-author required-status coverage, and the last-read/merge API race.
Aggregate review rounds 4-5 are parent-owned. This worker starts no reviews,
commits, pushes or PRs before the frozen-tree authorization.

S1 is fixed: ordinary-author runner tests require fresh state/head/target, publish
only the general required status, and forbid automatic authority. Stale-head,
wrong-target, closed-state and API-error regressions fail closed.

Round-4 accepted availability fixes: eliminate unchanged status writes and
prevent same-SHA manual/bot result oscillation. The original executor was
reproduced offline: 500 unchanged disabled scans wrote 1,000 statuses and blocked
same-head activation with GitHub's per-SHA/context cap. The fix caches the latest
trusted publisher state/description, updates its cache after writes, removes
routine pending writes, and keeps behind-main bot PRs ineligible. Genuine
execution failures still fail the workflow and revoke stale success, including
when the status-list API itself fails.

S2 now adds a fresh associated-PR query for ordinary heads. An open bot PR
currently targeting main on that SHA owns the generic context. Manual/fork scans
defer without writing. Closed or historical bot PRs do not deadlock ordinary
heads. Defense-in-depth tests still inject a newest generic success: stale pnupu
approval never authorizes the actual bot executor.

Final local result: **98/98 policy and native integration tests passed**. The
full repository gate passed, including its existing Jest suite and build.
Changed-workflow actionlint and SchemaStore workflow validation passed.
The actual runner's 1,000-write-cap fixtures run 500 unchanged scans each for
disabled, held, missing-approval, behind-main and ordinary heads. Repeated scans
write no extra status; same-head activation/approval recovery succeeds. Another
500 paired manual/fork and active-bot scans leave one stable blocked status.

These are offline/fixture results; live host vetoes and CI/CD dispatch remain
unverified because this task authorizes no production merge or deployment.
The five-minute schedule and repository-specific CI requirements are unchanged.
No new infrastructure, app, secret or credential is introduced.

Full-workflow actionlint separately reports three pre-existing obsolete CodeQL
v2 action-runner errors. The unchanged CodeQL workflow is outside this fix pass.
Changed-workflow validation is clean; no security action was upgraded or removed.
