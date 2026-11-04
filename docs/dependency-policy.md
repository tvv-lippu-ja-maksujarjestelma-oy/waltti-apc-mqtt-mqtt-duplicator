# Dependency approval policy: native GitHub adapter

Only `pnupu` can approve HUMAN dependency updates. No bot approval is created.
Mergify is not installed or required. The native adapter executes only trusted
code from the default branch. PR files are immutable API data, never code.

## Source and classification

The shared classifier, fixtures and historical signed Dependabot example come
from Git commit `f1422645c6fa930e615613227c4bb2e25b696423` of the canonical seed.
The classifier is unchanged except for a backwards-compatible
`requiredCheckCount` argument to eligibility. Its default remains two; this
adapter supplies the repository's explicit configured count. No CI is invented
or dropped. The native executor and its tests replace the seed's Mergify wiring.

AUTO covers only signed, verified, single-commit Dependabot metadata matching
the complete actual npm manifest and lock delta. Audited production `pino` and
development `prettier` and `eslint-config-prettier` patch/minor updates qualify.
Every changed lock entry must qualify. Unknown/mixed/transitive changes, majors,
0.x minors, runtime/base images, Actions, native/install-script dependencies,
security-sensitive libraries and tools generating shipped output require HUMAN.
Unknown formats and metadata fail to HUMAN. Security fixes have no exemption.
HUMAN requires pnupu's APPROVED User review on the exact current head. Bots,
other humans, stale and dismissed reviews do not qualify. Outstanding changes
requests block both lanes. Holds `help wanted`, `help-wanted`, and `hold` are case
insensitive. Drafts, conflicts and missing, pending or failing required CI block.

## Actual executor

The workflow revokes any previous native auto-merge request before evaluation,
even while activation is disabled. It never creates or enables one. Status writes
compare the latest trusted publisher state and description for the current SHA
and context; unchanged results create no write. Each successful write updates
the cache. There are no routine pending writes or periodic ready/failure cycles.
A status-list outage still permits a failure write to revoke stale success and
fails the workflow. Under strict protection, a behind-main PR stays ineligible. An eligible
update gets a full second read of files, commits, manifests, locks, reviews,
checks, statuses and PR labels/head/base after policy success, immediately before
a synchronous `pulls.merge` request with `sha` and `merge_method: rebase`.
GitHub branch protection remains effective; this request does not bypass it.
A refused attempt leaves no queued eligibility. API errors fail the policy status;
a rejected revocation/status write fails the workflow and needs operator action.
Events cover head/label/draft transitions, reviews through a token-free signal,
CI workflow completion, external status/check changes, and scheduled recovery.
All required CI contexts and application identities are explicit in
`activation.json`; newer failing check reruns supersede older successes.

GITHUB_TOKEN merges suppress push workflows. After a successful merge, the
adapter explicitly dispatches `ci-cd.yml` on `main`. That workflow retains the
existing Docker build/publish behavior on the trusted default branch. Dispatch
failure fails the adapter with the merged SHA and recovery instruction. The
operator must follow the dispatched CI/CD run to completion. This candidate
runs no real merge, deployment or publication.

## Activation remains disabled

Both `enabled` and `hostPrerequisitesVerified` are false. This is executable
candidate code, but an optional policy status does not enforce host merges.
Before a separately authorized activation:

1. Require `Dependency policy`, bound to GitHub Actions app ID 15368, alongside
   every existing app-bound check listed in this repository's activation file.
2. Keep strict up-to-date protection and admin enforcement. Audit bypass actors.
   Keep every PR-code job without status/check/repository writes; preserve the
   existing security-event permissions. CI checkout credentials are not persisted.
3. Verify the trusted token can revoke native auto-merge, publish statuses,
   perform a protected direct merge, and dispatch CI/CD. No new secret is needed.
   GITHUB_TOKEN has no administration permission; host protection inspection is
   a separate authorized operator action, recorded by the reviewed attestation.
4. Drain existing queued native requests and verify late hold/review/CI/head
   vetoes and successful dispatch on the host. Do not activate with a queued
   legacy request or a failed token/dispatch probe.
5. Verify S1 ordinary-author coverage: a fresh open non-Dependabot PR targeting
   main gets only the general required status. If a freshly confirmed open
   Dependabot PR targets main on that exact head, its result owns the generic
   context and the manual scan defers without overwriting it. Closed or
   historical bot PRs do not block normal manual heads. No AUTO status,
   approval, merge or enqueue is granted. Stale heads, changed targets and API
   failures fail closed. Manual merges still need Ilkka's explicit approval
   and existing CI.
6. Only then review a trusted commit setting both activation flags true.

### Narrow native limitation

GitHub's synchronous merge API accepts an expected head SHA, but no expected
label/review version. An asynchronous required status alone cannot give an atomic
late hold or approval-withdrawal veto. This adapter removes persistent queued
eligibility and repeats all mutable reads just before a synchronous merge, like
a live-condition executor. A label/review change between the last API read and
the merge transaction remains an unavoidable API race, not an atomic guarantee.
If the contract requires even that interval to be impossible, native parity is
blocked: the existing GitHub merge API has no such precondition. Do not enable
this candidate while treating its fresh read as an atomic host guarantee.
This limitation does not justify installing an App, service or credential here.
Intentional trusted-writer workflow sabotage is outside this task's boundary.

Sources: [merge API and SHA precondition](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request),
[GITHUB_TOKEN trigger exceptions](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow),
[workflow token permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions),
[branch protection read permissions](https://docs.github.com/en/rest/branches/branch-protection#get-branch-protection).
