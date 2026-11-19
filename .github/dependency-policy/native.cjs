/* Trusted default-branch executor. Never loads code from the PR. */
/* eslint-disable @typescript-eslint/no-require-imports */
const activation = require("./activation.json");
const WORKFLOW = "ci-cd.yml";
const REQUIRED = activation.requiredChecks;
const PUBLISHER = "github-actions[bot]";
const BLOCKED =
  "Policy, current pnupu approval, hold, conflict or required CI blocks merge";
const CANARY_BLOCKED = "Canary policy blocks merge";
const CANARY_MAX_MS = 24 * 60 * 60 * 1000;
const MERGE_AUTHORIZED =
  "Dependency policy passed; no native auto-merge request is queued";
const RETRY_REQUIRED =
  "Protected merge did not complete: retry via workflow_dispatch";
const STATUS_CAP = 1000; // GitHub limit per SHA and context, across publishers.

function validCanary(canary) {
  if (
    !canary ||
    typeof canary !== "object" ||
    Array.isArray(canary) ||
    Object.keys(canary).some(
      (key) => !["pr", "issuedAt", "expiresAt", "mergeApproved"].includes(key),
    )
  )
    return false;
  // Timestamps are UTC Unix milliseconds. Approval, when present, is a full SHA.
  const { pr, issuedAt, expiresAt, mergeApproved } = canary;
  return (
    Number.isSafeInteger(pr) &&
    pr > 0 &&
    Number.isSafeInteger(issuedAt) &&
    issuedAt > 0 &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt > issuedAt &&
    expiresAt - issuedAt <= CANARY_MAX_MS &&
    (mergeApproved == null ||
      (typeof mergeApproved === "string" &&
        mergeApproved.length === 40 &&
        /^[0-9a-f]{40}$/.test(mergeApproved)))
  );
}

function checkStates(required, runs, statuses) {
  return required.map(({ context, app_id }) => {
    const matching = runs
      .filter((r) => r.name === context && r.app?.id === app_id)
      .sort((a, b) => b.id - a.id);
    if (matching.length)
      return matching[0].status === "completed"
        ? matching[0].conclusion
        : "pending";
    const publisher = {
      15368: "github-actions[bot]",
      57789: "github-advanced-security[bot]",
    }[app_id];
    return statuses
      .filter(
        (s) =>
          publisher && s.context === context && s.creator?.login === publisher,
      )
      .sort((a, b) => b.id - a.id)[0]?.state;
  });
}

async function run({
  github,
  context,
  core,
  policy,
  enabled = activation.enabled,
  hostPrerequisitesVerified = activation.hostPrerequisitesVerified,
  canary = activation.canary,
  requiredChecks = REQUIRED,
  now = Date.now,
}) {
  const isCanary = canary != null;
  const wellFormedCanary = validCanary(canary);
  const inCanaryWindow = wellFormedCanary
    ? () => {
        const time = now();
        return canary.issuedAt <= time && time < canary.expiresAt;
      }
    : () => false;
  policy ||=
    enabled || wellFormedCanary
      ? require("./policy.cjs")
      : { CONTEXT: "Dependency policy" };
  const { classify, eligible, CONTEXT } = policy;
  const isOwnPolicyStatus = (s) =>
    s.context === CONTEXT && s.creator?.login === PUBLISHER;
  const repo = context.repo;
  const list = (method, args) =>
    github.paginate(method, { ...repo, per_page: 100, ...args });
  const pulls = context.payload.pull_request
    ? [context.payload.pull_request]
    : await list(github.rest.pulls.list, { state: "open", base: "main" });
  for (const candidate of pulls) {
    const pull_number = candidate.number;
    const args = { ...repo, pull_number };
    let sha = candidate.head.sha;
    let cached, cachedSHA;
    let canaryBot = false;
    let authorizationAttempted = false;
    const latestOwn = () =>
      cached.filter(isOwnPolicyStatus).sort((a, b) => b.id - a.id)[0];
    const readStatuses = async () => {
      cached = await list(github.rest.repos.listCommitStatusesForRef, {
        ref: sha,
      });
      cachedSHA = sha;
      return cached;
    };
    const publish = async (state, description, force = false) => {
      description = description.slice(0, 140);
      if (!cached || cachedSHA !== sha) {
        try {
          await readStatuses();
        } catch (error) {
          // A status-list outage must not prevent revoking a known success.
          // Success still requires the read; only fail-closed writes can proceed.
          if (state !== "failure") throw error;
          cached = [];
          cachedSHA = sha;
        }
      }
      const previous = latestOwn();
      if (
        !force &&
        previous?.state === state &&
        previous.description === description
      )
        return;
      const { data: written } = await github.rest.repos.createCommitStatus({
        ...repo,
        sha,
        context: CONTEXT,
        state,
        description,
      });
      // Keep this evaluation's cache consistent with every successful write.
      cached = [written, ...cached];
    };
    const getPR = async () => (await github.rest.pulls.get(args)).data;
    const revoke = async (pr) => {
      if (!pr.auto_merge) return;
      await github.graphql(
        "mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } } }",
        { id: pr.node_id },
      );
      if ((await getPR()).auto_merge)
        throw new Error("Native auto-merge revocation did not take effect");
    };
    try {
      const pr = await getPR();
      sha = pr.head.sha;
      // S1: a globally required status must not deadlock ordinary author PRs.
      // This general status authorizes no AUTO lane, bot approval or merge.
      if (pr.user.login !== "dependabot[bot]") {
        // General statuses are SHA-scoped. An active same-head bot PR owns the
        // context, so a manual/fork scan must not overwrite its blocked result.
        const associated = await list(
          github.rest.repos.listPullRequestsAssociatedWithCommit,
          { commit_sha: sha },
        );
        let botOwnsHead = false;
        for (const other of associated) {
          if (other.user?.login !== "dependabot[bot]") continue;
          const { data: active } = await github.rest.pulls.get({
            ...repo,
            pull_number: other.number,
          });
          if (
            active.state === "open" &&
            active.base.ref === "main" &&
            active.user.login === "dependabot[bot]" &&
            active.head.sha === sha
          ) {
            botOwnsHead = true;
            break;
          }
        }
        const fresh = await getPR();
        if (
          pr.state !== "open" ||
          fresh.state !== "open" ||
          pr.base.ref !== "main" ||
          fresh.base.ref !== "main" ||
          fresh.head.sha !== sha ||
          fresh.base.sha !== pr.base.sha ||
          fresh.user.login !== pr.user.login
        )
          throw new Error(
            "Ordinary PR state/head/target changed during evaluation",
          );
        if (botOwnsHead) {
          core.info(
            `PR ${pull_number}: defer general status to active same-head Dependabot PR`,
          );
          continue;
        }
        await publish(
          "success",
          "Ordinary author PR: manual approval and existing required CI still apply; no dependency AUTO authorization",
        );
        continue;
      }
      canaryBot = isCanary;
      await revoke(pr); // Also revoke old queued requests while activation is disabled.
      if (pr.state !== "open" || pr.base.ref !== "main") continue;
      if (isCanary && (!inCanaryWindow() || canary.pr !== pull_number)) {
        await publish("failure", CANARY_BLOCKED);
        continue;
      }
      if (!isCanary && !enabled) {
        await publish(
          "failure",
          "Activation disabled: final shared source and host prerequisites required",
        );
        continue;
      }
      if (
        (!isCanary && !hostPrerequisitesVerified) ||
        !requiredChecks.length ||
        requiredChecks.some((r) => !r.context || !Number.isInteger(r.app_id))
      )
        throw new Error(
          "Host prerequisite attestation or required-check configuration missing",
        );
      // Only a separately approved exact head can enter the canary merge path.
      // Observation keeps the required status red even if an old success exists.
      const observing =
        isCanary && (!canary.mergeApproved || canary.mergeApproved !== sha);
      // Both bot PRs can share a SHA. Keep their blocking writes identical.
      const blocked = isCanary ? CANARY_BLOCKED : BLOCKED;
      if (observing) await publish("failure", blocked);
      const ci = requiredChecks;
      const evaluate = async () => {
        const current = await getPR();
        if (current.head.sha !== sha || current.base.sha !== pr.base.sha)
          throw new Error("Head/base changed during evaluation");
        await revoke(current);
        const files = await list(github.rest.pulls.listFiles, { pull_number });
        if (files.length !== current.changed_files)
          throw new Error("Incomplete file inventory");
        const commits = await list(github.rest.pulls.listCommits, {
          pull_number,
        });
        const read = async (ref, path) => {
          const { data } = await github.rest.repos.getContent({
            ...repo,
            ref,
            path,
          });
          if (data.encoding !== "base64" || !data.content)
            throw new Error("Unsupported file content");
          return JSON.parse(
            Buffer.from(data.content, "base64").toString("utf8"),
          );
        };
        let before, after;
        if (
          files.every((f) =>
            ["package.json", "package-lock.json"].includes(f.filename),
          )
        ) {
          [before, after] = await Promise.all(
            [pr.base.sha, sha].map((ref) =>
              Promise.all(
                ["package.json", "package-lock.json"].map((path) =>
                  read(ref, path),
                ),
              ),
            ),
          );
        }
        const classification = classify({
          files,
          commits,
          before,
          after,
          head: sha,
        });
        const reviews = await list(github.rest.pulls.listReviews, {
          pull_number,
        });
        const runs = await list(github.rest.checks.listForRef, { ref: sha });
        const statuses = await readStatuses();
        // A required status is SHA-scoped. Do not authorize a second bot PR
        // accidentally when issuing a canary's merge-authorizing status.
        const sharedBotHead =
          isCanary &&
          !observing &&
          (
            await list(github.rest.pulls.list, { state: "open", base: "main" })
          ).some(
            (other) =>
              other.number !== pull_number &&
              other.user?.login === "dependabot[bot]" &&
              other.head.sha === sha,
          );
        const fresh = await getPR();
        if (
          fresh.head.sha !== sha ||
          fresh.base.sha !== pr.base.sha ||
          fresh.auto_merge
        )
          throw new Error(
            "Head/base or native auto-merge changed during evaluation",
          );
        return (
          !sharedBotHead &&
          (!isCanary || inCanaryWindow()) &&
          fresh.mergeable_state !== "behind" &&
          eligible({
            pr: fresh,
            classification,
            reviews,
            checks: checkStates(ci, runs, statuses),
            requiredCheckCount: ci.length,
            activated: true,
          })
        );
      };
      const passes = await evaluate();
      if (observing) {
        core.info(
          `Canary PR ${pull_number} at ${sha}: ${passes ? "eligible" : "blocked"} (observation only)`,
        );
        continue;
      }
      if (!passes || (isCanary && !inCanaryWindow())) {
        await publish("failure", blocked);
        continue;
      }
      const retryLatched = cached.some(
        (s) =>
          isOwnPolicyStatus(s) &&
          ((s.state === "failure" && s.description === RETRY_REQUIRED) ||
            (s.state === "success" && s.description === MERGE_AUTHORIZED)),
      );
      if (retryLatched) {
        // A recorded merge authorization on a still-open PR is an incomplete
        // attempt, even if the earlier rollback write failed.
        if (latestOwn()?.state !== "failure")
          await publish("failure", RETRY_REQUIRED);
        if (context.eventName !== "workflow_dispatch") {
          core.info(`PR ${pull_number}: ${RETRY_REQUIRED}`);
          continue;
        }
      }
      const slotsNeeded = retryLatched ? 2 : 3;
      if (
        cached.filter((s) => s.context === CONTEXT).length >
        STATUS_CAP - slotsNeeded
      )
        throw new Error(
          "Insufficient status capacity for a protected merge and its revocation",
        );
      // Native auto-merge can consume a green status before the fresh reread.
      // Require the repository setting to be explicitly off, even without a queue.
      const { data: repository } = await github.rest.repos.get(repo);
      if (repository?.allow_auto_merge !== false)
        throw new Error(
          "Repository native auto-merge must be explicitly disabled",
        );
      // Confirm a durable red marker before the first green attempt. If both
      // green and rollback fail to record, automated retries must still stop.
      if (!retryLatched) await publish("failure", RETRY_REQUIRED);
      if (isCanary && !inCanaryWindow()) {
        await publish("failure", blocked);
        continue;
      }
      authorizationAttempted = true;
      await publish("success", MERGE_AUTHORIZED);
      // A complete second read follows the status write: no cached approval or CI.
      if (!(await evaluate()) || (isCanary && !inCanaryWindow())) {
        await publish("failure", RETRY_REQUIRED, true);
        continue;
      }
      const { data: merged } = await github.rest.pulls.merge({
        ...args,
        sha,
        merge_method: "rebase",
      });
      if (!merged.merged)
        throw new Error(`Direct merge refused: ${merged.message}`);
      core.info(`Merged PR ${pull_number}: ${merged.sha}`);
      // GITHUB_TOKEN merges do not trigger push workflows. Explicit dispatch is
      // exempt and runs trusted main CI/CD, including its existing Docker push.
      try {
        await github.rest.actions.createWorkflowDispatch({
          ...repo,
          workflow_id: WORKFLOW,
          ref: "main",
        });
      } catch (error) {
        core.setFailed(
          `PR ${pull_number} merged as ${merged.sha}, but CI/CD dispatch failed: ${error.message}. Dispatch ${WORKFLOW} on main.`,
        );
      }
    } catch (error) {
      core.warning(`PR ${pull_number}: ${error.message}`);
      core.setFailed(`PR ${pull_number}: ${error.message}`);
      try {
        // A green write can reach GitHub even if its response is lost.
        // After attempting it, a cached red cannot stand in for rollback.
        await publish(
          "failure",
          authorizationAttempted
            ? RETRY_REQUIRED
            : canaryBot
              ? CANARY_BLOCKED
              : `Fail closed: ${error.message}`,
          authorizationAttempted,
        );
      } catch (writeError) {
        core.setFailed(`Cannot revoke policy status: ${writeError.message}`);
      }
    }
  }
}
module.exports = { run, checkStates, REQUIRED };
/* eslint-enable @typescript-eslint/no-require-imports */
