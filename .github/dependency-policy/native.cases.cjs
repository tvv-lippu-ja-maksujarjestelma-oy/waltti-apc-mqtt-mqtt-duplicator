/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const policy = require("./policy.cjs");
const { run, REQUIRED, checkStates } = require("./native.cjs");
const { repositoryFixture } = require("./fixtures.cjs");
const approve = (
  login = "pnupu",
  state = "APPROVED",
  head = "head",
  type = "User",
) => ({ user: { login, type }, state, commit_id: head });
function harness() {
  const fixture = repositoryFixture();
  const h = {
    hostVerified: true,
    repository: { allow_auto_merge: false },
    fixture,
    calls: [],
    errors: [],
    warnings: [],
    logs: [],
    reviews: [],
    statuses: [],
    associated: [],
    otherPRs: new Map(),
    acceptedWrites: new Map(),
    statusLimit: 1000,
    pr: {
      number: 42,
      node_id: "PR42",
      state: "open",
      draft: false,
      mergeable: true,
      base: { ref: "main", sha: "base" },
      head: { sha: "head" },
      labels: [],
      changed_files: 2,
      user: { login: "dependabot[bot]" },
      auto_merge: null,
    },
    protection: {
      enforce_admins: { enabled: true },
      required_status_checks: {
        strict: true,
        checks: [...REQUIRED, { context: policy.CONTEXT, app_id: 15368 }],
      },
    },
    runs: REQUIRED.map((r, i) => ({
      id: i + 1,
      name: r.context,
      app: { id: r.app_id },
      status: "completed",
      conclusion: "success",
    })),
    onRead: () => {},
    onPublish: () => {},
    onPublished: () => {},
    onMerge: () => {},
    onDispatch: () => {},
    onRevoke: () => {},
    onStatuses: () => {},
    onRepository: () => {},
  };
  let reads = 0;
  const api = (name, fn) => async (args) => {
    h.calls.push({ name, args });
    return { data: await fn(args) };
  };
  const github = {
    rest: {
      pulls: {
        list: api("list", () =>
          [h.pr, ...h.otherPRs.values()].filter(
            (pr) => pr.state === "open" && pr.base.ref === "main",
          ),
        ),
        get: api("get", ({ pull_number }) => {
          h.onRead(++reads);
          const pr =
            h.pr.number === pull_number ? h.pr : h.otherPRs.get(pull_number);
          if (!pr) throw new Error("Unknown PR");
          return structuredClone(pr);
        }),
        listFiles: api("files", () => h.fixture.files),
        listCommits: api("commits", () => h.fixture.commits),
        listReviews: api("reviews", () => h.reviews),
        merge: api("merge", (args) => {
          const { sha, pull_number } = args;
          const { strict, checks } = h.protection.required_status_checks;
          const current = h.statuses.filter((s) => s.sha === sha);
          if (
            h.pr.number !== pull_number ||
            h.pr.head.sha !== sha ||
            h.pr.state !== "open" ||
            h.pr.base.ref !== "main" ||
            h.pr.draft ||
            h.pr.mergeable !== true ||
            (strict && h.pr.mergeable_state === "behind") ||
            !checkStates(checks, h.runs, current).every(
              (state) => state === "success",
            )
          )
            throw new Error("Protected merge rejected by GitHub");
          return h.onMerge(args) ?? { merged: true, sha: "merged" };
        }),
      },
      repos: {
        get: api("repository", () => {
          h.onRepository();
          return h.repository;
        }),
        getBranchProtection: api("protection", () => h.protection),
        listPullRequestsAssociatedWithCommit: api(
          "associated",
          () => h.associated,
        ),
        getContent: api("content", ({ ref, path }) => ({
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify(
              h.fixture[ref === h.pr.base.sha ? "before" : "after"][
                path === "package.json" ? 0 : 1
              ],
            ),
          ).toString("base64"),
        })),
        listCommitStatusesForRef: api("statuses", ({ ref }) => {
          h.onStatuses();
          return h.statuses.filter((s) => s.sha === undefined || s.sha === ref);
        }),
        createCommitStatus: api("publish", (s) => {
          h.onPublish(s);
          const key = `${s.sha}:${s.context}`;
          const count = h.acceptedWrites.get(key) || 0;
          if (count >= h.statusLimit)
            throw new Error("422: 1000 statuses per SHA/context limit");
          h.acceptedWrites.set(key, count + 1);
          const written = {
            ...s,
            id: h.statuses.length + 1,
            creator: { login: "github-actions[bot]" },
          };
          h.statuses.unshift(written);
          h.onPublished(written);
          return written;
        }),
      },
      checks: { listForRef: api("checks", () => h.runs) },
      actions: {
        createWorkflowDispatch: api("dispatch", () => {
          h.onDispatch();
          return {};
        }),
      },
    },
    graphql: async (_query, args) => {
      h.calls.push({ name: "revoke", args });
      h.onRevoke();
      const queued = [h.pr, ...h.otherPRs.values()].find(
        (pr) => pr.node_id === args.id,
      );
      queued.auto_merge = null;
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  h.execute = (enabled = true, overrides = {}) =>
    run({
      github,
      context: {
        repo: { owner: "test", repo: "test" },
        payload: { pull_request: structuredClone(h.pr) },
        eventName: h.eventName,
      },
      core: {
        info: (s) => h.logs.push(s),
        warning: (s) => h.warnings.push(s),
        setFailed: (s) => h.errors.push(s),
      },
      policy,
      enabled,
      hostPrerequisitesVerified: h.hostVerified,
      requiredChecks: h.protection.required_status_checks.checks.filter(
        (c) => c.context !== policy.CONTEXT,
      ),
      ...overrides,
    });
  h.merged = () => h.calls.some((c) => c.name === "merge");
  h.lastStatus = () =>
    h.calls.filter((c) => c.name === "publish").at(-1)?.args.state;
  return h;
}
test("real repository lock delta with signed metadata reaches head-matched direct merge and CI/CD dispatch", async () => {
  const h = harness();
  await h.execute();
  assert.equal(h.merged(), true);
  assert.deepEqual(h.calls.find((c) => c.name === "merge").args, {
    owner: "test",
    repo: "test",
    pull_number: 42,
    sha: "head",
    merge_method: "rebase",
  });
  assert.equal(h.calls.filter((c) => c.name === "files").length, 2);
  assert.equal(h.calls.filter((c) => c.name === "reviews").length, 2);
  assert.equal(h.calls.filter((c) => c.name === "checks").length, 2);
  assert.equal(h.calls.filter((c) => c.name === "content").length, 8);
  assert.deepEqual(h.calls.at(-1), {
    name: "dispatch",
    args: {
      owner: "test",
      repo: "test",
      workflow_id: "ci-cd.yml",
      ref: "main",
    },
  });
});
test("ordinary production pino patch qualifies with the entire actual lock", async () => {
  const h = harness();
  const manifest = JSON.parse(fs.readFileSync("package.json"));
  const lock = JSON.parse(fs.readFileSync("package-lock.json"));
  h.fixture.before = [manifest, lock];
  h.fixture.after = structuredClone(h.fixture.before);
  h.fixture.after[0].dependencies.pino = "^10.4.1";
  h.fixture.after[1].packages[""].dependencies.pino = "^10.4.1";
  for (const entry of [
    h.fixture.after[1].packages["node_modules/pino"],
    h.fixture.after[1].dependencies?.pino,
  ].filter(Boolean))
    Object.assign(entry, {
      version: "10.4.1",
      resolved: "https://registry.npmjs.org/pino/-/pino-10.4.1.tgz",
      integrity: "sha512-fixture",
    });
  h.fixture.commits[0].commit.message =
    "---\nupdated-dependencies:\n- dependency-name: pino\n  dependency-version: 10.4.1\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...\n";
  await h.execute();
  assert.equal(h.merged(), true);
});
for (const [name, reviews, allowed] of [
  ["current pnupu", [approve()], true],
  ["bot-only", [approve("dependabot[bot]", "APPROVED", "head", "Bot")], false],
  ["foreign human", [approve("other")], false],
  ["stale pnupu", [approve("pnupu", "APPROVED", "old")], false],
  ["dismissed pnupu", [approve(), approve("pnupu", "DISMISSED")], false],
])
  test(`${name} review on unknown dependency data`, async () => {
    const h = harness();
    h.fixture.commits[0].commit.message = "unclassified";
    h.reviews = reviews;
    await h.execute();
    assert.equal(h.merged(), allowed);
  });
for (const [name, mutate] of [
  [
    "mixed transitive delta",
    (h) => {
      h.fixture.after[1].packages["node_modules/unknown"] = {
        version: "1.2.3",
      };
    },
  ],
  [
    "unsigned metadata",
    (h) => {
      h.fixture.commits[0].commit.verification.verified = false;
    },
  ],
  [
    "pending CI",
    (h) => {
      h.runs[0].status = "in_progress";
    },
  ],
  [
    "failed CI",
    (h) => {
      h.runs[0].conclusion = "failure";
    },
  ],
  [
    "missing CI",
    (h) => {
      h.runs.pop();
    },
  ],
  [
    "foreign check app",
    (h) => {
      h.runs[0].app.id = 999;
    },
  ],
  [
    "newer failing rerun",
    (h) => {
      h.runs.push({ ...h.runs[0], id: 900, conclusion: "failure" });
    },
  ],
  [
    "draft",
    (h) => {
      h.pr.draft = true;
    },
  ],
  [
    "conflict",
    (h) => {
      h.pr.mergeable = false;
    },
  ],
  [
    "changes requested",
    (h) => {
      h.reviews = [approve("other", "CHANGES_REQUESTED")];
    },
  ],
  [
    "missing host attestation",
    (h) => {
      h.hostVerified = false;
    },
  ],
  [
    "empty CI inventory",
    (h) => {
      h.protection.required_status_checks.checks = [];
    },
  ],
  [
    "extra missing required CI",
    (h) => {
      h.protection.required_status_checks.checks.push({
        context: "Extra",
        app_id: 15368,
      });
    },
  ],
])
  test(`${name} blocks direct merge`, async () => {
    const h = harness();
    mutate(h);
    await h.execute();
    assert.equal(h.merged(), false);
    assert.equal(h.lastStatus(), "failure");
  });
for (const label of ["help wanted", "help-wanted", "hold", "HOLD"])
  test(`late ${label} after eligibility revokes success and existing native auto-merge`, async () => {
    const h = harness();
    h.pr.auto_merge = { enabled: true };
    h.onPublish = (s) => {
      if (s.state === "success") h.pr.labels = [{ name: label }];
    };
    await h.execute();
    assert.equal(h.merged(), false);
    assert.equal(h.lastStatus(), "failure");
    assert.equal(h.calls[1].name, "revoke");
    assert.equal(h.pr.auto_merge, null);
  });
for (const [name, mutate] of [
  [
    "pnupu dismissal",
    (h) => {
      h.reviews.push(approve("pnupu", "DISMISSED"));
    },
  ],
  [
    "head change",
    (h) => {
      h.pr.head.sha = "new-head";
    },
  ],
  [
    "base change",
    (h) => {
      h.pr.base.sha = "new-base";
    },
  ],
  [
    "CI failure",
    (h) => {
      h.runs[0].conclusion = "failure";
    },
  ],
  [
    "new native auto-merge request",
    (h) => {
      h.pr.auto_merge = { enabled: true };
      h.pr.labels = [{ name: "hold" }];
    },
  ],
])
  test(`fresh evaluation catches late ${name}`, async () => {
    const h = harness();
    h.fixture.commits[0].commit.message = "unknown";
    h.reviews = [approve()];
    h.onPublish = (s) => {
      if (s.state === "success") mutate(h);
    };
    await h.execute();
    assert.equal(h.merged(), false);
    assert.equal(h.lastStatus(), "failure");
  });
test("disabled activation revokes pre-existing auto-merge without classification or merge", async () => {
  const h = harness();
  h.pr.auto_merge = { enabled: true };
  await h.execute(false);
  assert.equal(h.pr.auto_merge, null);
  assert.equal(h.merged(), false);
  assert.equal(h.lastStatus(), "failure");
});
test("server rejects current head mismatch without dispatch or queued eligibility", async () => {
  const h = harness();
  h.onMerge = ({ sha }) => {
    assert.equal(sha, "head");
    throw new Error("409 head mismatch");
  };
  await h.execute();
  assert.equal(h.lastStatus(), "failure");
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );
});
test("legacy statuses require trusted publishers", () => {
  assert.deepEqual(
    checkStates(
      [REQUIRED.at(-1)],
      [],
      [
        {
          id: 1,
          context: REQUIRED.at(-1).context,
          state: "success",
          creator: { login: "someone" },
        },
      ],
    ),
    [undefined],
  );
});
test("workflow uses default code, has all veto signals, and never enables a queued merge", () => {
  const y = fs.readFileSync(
    ".github/workflows/dependabot-auto-approve.yml",
    "utf8",
  );
  for (const s of [
    "pull_request_target:",
    "synchronize",
    "labeled",
    "unlabeled",
    "converted_to_draft",
    "auto_merge_enabled",
    "workflow_run:",
    "Dependency review signal",
    "CodeQL",
    "status:",
    "check_run:",
    "schedule:",
    "workflow_dispatch:",
    "canary_pr:",
    "approved_head:",
    "persist-credentials: false",
    "ref: ${{ github.event.repository.default_branch }}",
  ])
    assert.ok(y.includes(s), s);
  assert.doesNotMatch(
    y,
    /gh pr (review|merge)|pull_request.head|npm (ci|install)/,
  );
  const executor = fs.readFileSync(
    ".github/dependency-policy/native.cjs",
    "utf8",
  );
  assert.match(executor, /disablePullRequestAutoMerge/);
  assert.doesNotMatch(
    executor,
    /enablePullRequestAutoMerge|merge-async|--auto/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(".github/dependency-policy/activation.json"))
      .enabled,
    false,
  );
});
test("untrusted dependency execution has no inherited status/check writer and no persisted CI credentials", () => {
  const ci = fs.readFileSync(".github/workflows/ci-cd.yml", "utf8");
  assert.match(ci, /permissions:\n {2}contents: read/);
  assert.match(ci, /persist-credentials: false/);
  assert.match(ci, /workflow_dispatch:/);
  assert.match(ci, /if: \$\{\{ github.ref == 'refs\/heads\/main' \}\}/);
  for (const file of ["codeql.yml", "trivy.yml"]) {
    const y = fs.readFileSync(`.github/workflows/${file}`, "utf8");
    assert.match(y, /permissions:/);
    assert.doesNotMatch(y, /(?:statuses|checks|contents|pull-requests): write/);
  }
  const review = fs.readFileSync(
    ".github/workflows/dependency-review-signal.yml",
    "utf8",
  );
  assert.match(review, /permissions: \{\}/);
  assert.doesNotMatch(review, /uses:|checkout|secrets\./);
});

test("dispatch failure reports the merged SHA and recovery without hiding the merge", async () => {
  const h = harness();
  h.onDispatch = () => {
    throw new Error("dispatch denied");
  };
  await h.execute();
  assert.equal(h.merged(), true);
  assert.ok(
    h.errors.some(
      (s) => s.includes("merged as merged") && s.includes("dispatch failed"),
    ),
  );
});
test("failed native revocation stops before policy success or merge", async () => {
  const h = harness();
  h.pr.auto_merge = { enabled: true };
  h.onRevoke = () => {
    throw new Error("revocation denied");
  };
  await h.execute();
  assert.equal(h.merged(), false);
  assert.equal(h.lastStatus(), "failure");
  assert.ok(h.errors.some((s) => s.includes("revocation denied")));
});

test("S1 ordinary human PR gets only the general required status, never AUTO or merge", async () => {
  const h = harness();
  h.pr.user.login = "human";
  await h.execute(false);
  assert.equal(h.lastStatus(), "success");
  assert.equal(h.merged(), false);
  assert.deepEqual(
    h.calls.map((c) => c.name),
    ["get", "associated", "get", "statuses", "publish"],
  );
  assert.ok(
    h.calls
      .filter((c) => c.name === "publish")
      .every((c) => c.args.context === policy.CONTEXT),
  );
});
for (const [name, mutate] of [
  [
    "stale head",
    (h) => {
      h.pr.head.sha = "changed";
    },
  ],
  [
    "wrong target",
    (h) => {
      h.pr.base.ref = "other";
    },
  ],
  [
    "closed state",
    (h) => {
      h.pr.state = "closed";
    },
  ],
  [
    "API error",
    () => {
      throw new Error("PR read denied");
    },
  ],
])
  test(`S1 ordinary human ${name} fails closed without automatic authority`, async () => {
    const h = harness();
    h.pr.user.login = "human";
    h.onRead = (count) => {
      if (count === 2) mutate(h);
    };
    await h.execute();
    assert.equal(h.lastStatus(), "failure");
    assert.equal(h.merged(), false);
    assert.equal(
      h.calls.some((c) =>
        ["files", "commits", "merge", "revoke", "dispatch"].includes(c.name),
      ),
      false,
    );
  });

test("S2 same-SHA human/fork general success cannot authorize a HUMAN Dependabot PR with stale approval", async () => {
  const h = harness();
  // Keep authenticated Dependabot trailers, but add an uncovered transitive
  // integrity delta so the full real lockfile comparison requires HUMAN.
  h.fixture.after[1].packages["node_modules/typescript"].integrity =
    "sha512-changed-transitive";
  assert.equal(policy.classify(h.fixture).lane, "HUMAN");
  h.reviews = [approve("pnupu", "APPROVED", "previous-head")];
  const bot = h.pr;
  await h.execute();
  assert.equal(h.lastStatus(), "failure");
  assert.equal(h.merged(), false);
  const manualStart = h.calls.length;
  h.pr = {
    ...structuredClone(bot),
    number: 43,
    node_id: "PR43",
    user: { login: "human" },
    head: { ...bot.head, repo: { fork: true } },
  };
  h.associated = [bot];
  h.otherPRs.set(bot.number, bot);
  await h.execute();
  assert.equal(h.statuses[0].state, "failure");
  assert.deepEqual(
    h.calls.slice(manualStart).map((c) => c.name),
    ["get", "associated", "get", "get"],
  );
  // Defense in depth: even an externally supplied newest generic success must
  // not replace fresh native authorization for the actual bot PR.
  h.statuses.unshift({
    ...h.statuses[0],
    id: h.statuses.length + 1,
    state: "success",
    description: "ordinary same-SHA success",
  });
  const collision = h.statuses[0];
  assert.equal(collision.context, policy.CONTEXT);
  assert.equal(collision.sha, bot.head.sha);
  assert.equal(collision.state, "success");
  const botStart = h.calls.length;
  let collisionRead = false;
  h.onStatuses = () => {
    assert.equal(h.statuses[0].context, policy.CONTEXT);
    assert.equal(h.statuses[0].state, "success");
    collisionRead = true;
  };
  h.pr = bot;
  await h.execute();
  assert.equal(h.lastStatus(), "failure");
  assert.equal(h.merged(), false);
  assert.equal(
    h.calls.some((c) => ["merge", "dispatch"].includes(c.name)),
    false,
  );
  assert.equal(collisionRead, true);
  const reread = h.calls.slice(botStart);
  for (const name of [
    "get",
    "files",
    "commits",
    "content",
    "reviews",
    "checks",
    "statuses",
  ])
    assert.ok(
      reread.some((c) => c.name === name),
      name,
    );
  assert.ok(
    reread
      .filter((c) => ["files", "commits", "reviews"].includes(c.name))
      .every((c) => c.args.pull_number === 42),
  );
  assert.ok(h.statuses.every((s) => s.context === policy.CONTEXT));
});

function writeCount(h) {
  return [...h.acceptedWrites.values()].reduce((sum, n) => sum + n, 0);
}
for (const mode of ["disabled", "held", "missing approval", "behind"])
  test(`1000-status cap: 500 unchanged ${mode} scans deduplicate and same-head recovery succeeds`, async () => {
    const h = harness();
    const head = h.pr.head.sha;
    h.pr.auto_merge = { enabled: true };
    if (mode === "held") h.pr.labels = [{ name: "help wanted" }];
    if (mode === "missing approval")
      h.fixture.after[1].packages["node_modules/typescript"].integrity =
        "sha512-uncovered";
    if (mode === "behind") h.pr.mergeable_state = "behind";
    for (let scan = 0; scan < 500; scan++) await h.execute(mode !== "disabled");
    assert.equal(h.statusLimit, 1000);
    assert.equal(writeCount(h), 1);
    assert.equal(h.statuses[0].state, "failure");
    assert.equal(h.pr.auto_merge, null);
    assert.equal(h.merged(), false);
    const before = h.calls.length;
    await h.execute(mode !== "disabled");
    assert.equal(writeCount(h), 1);
    assert.equal(
      h.calls.slice(before).some((c) => c.name === "publish"),
      false,
    );
    h.pr.labels = [];
    h.pr.mergeable_state = "clean";
    h.reviews = [approve()];
    await h.execute();
    assert.equal(h.pr.head.sha, head);
    assert.equal(writeCount(h), 3);
    assert.equal(h.merged(), true);
    assert.equal(h.calls.at(-1).name, "dispatch");
    assert.deepEqual(h.errors, []);
  });
test("ordinary success is deduplicated across 500 unchanged scans", async () => {
  const h = harness();
  h.pr.user.login = "human";
  for (let scan = 0; scan < 500; scan++) await h.execute();
  assert.equal(writeCount(h), 1);
  const before = h.calls.length;
  await h.execute();
  assert.equal(writeCount(h), 1);
  assert.equal(
    h.calls.slice(before).some((c) => c.name === "publish"),
    false,
  );
  assert.equal(h.statuses[0].state, "success");
  assert.equal(h.merged(), false);
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );
});
test("same-SHA ordinary/fork and active bot scans cannot oscillate the general context", async () => {
  const h = harness();
  h.pr.labels = [{ name: "hold" }];
  const bot = h.pr;
  const manual = {
    ...structuredClone(bot),
    number: 43,
    node_id: "PR43",
    user: { login: "human" },
    head: { ...bot.head, repo: { fork: true } },
  };
  h.associated = [bot];
  h.otherPRs.set(bot.number, bot);
  for (let scan = 0; scan < 500; scan++) {
    h.pr = bot;
    await h.execute();
    h.pr = manual;
    await h.execute();
  }
  assert.equal(writeCount(h), 1);
  assert.equal(h.statuses[0].state, "failure");
  assert.equal(h.merged(), false);
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );
  const before = h.calls.length;
  h.pr = bot;
  await h.execute();
  h.pr = manual;
  await h.execute();
  assert.equal(
    h.calls.slice(before).some((c) => c.name === "publish"),
    false,
  );
  assert.deepEqual(h.errors, []);
});
for (const mode of ["closed", "historical head", "other target"])
  test(`fresh associated-PR check does not deadlock a manual head on ${mode} bot history`, async () => {
    const h = harness();
    const bot = structuredClone(h.pr);
    h.pr = { ...structuredClone(bot), number: 43, user: { login: "human" } };
    h.associated = [bot];
    const freshBot = structuredClone(bot);
    if (mode === "closed") freshBot.state = "closed";
    if (mode === "historical head") freshBot.head.sha = "new-bot-head";
    if (mode === "other target") freshBot.base.ref = "other";
    h.otherPRs.set(bot.number, freshBot);
    await h.execute();
    assert.equal(h.statuses[0].state, "success");
    assert.equal(h.merged(), false);
    assert.equal(
      h.calls.some((c) => c.name === "dispatch"),
      false,
    );
    assert.ok(
      h.calls.some(
        (c) => c.name === "get" && c.args.pull_number === bot.number,
      ),
    );
  });
test("associated-PR API failure revokes stale manual success without granting authority", async () => {
  const h = harness();
  h.pr.user.login = "human";
  await h.execute();
  h.associated = [{ number: 99, user: { login: "dependabot[bot]" } }];
  await h.execute();
  assert.equal(h.statuses[0].state, "failure");
  assert.equal(h.merged(), false);
  assert.ok(h.errors.some((e) => e.includes("Unknown PR")));
});
test("status cache ignores foreign publishers and includes each successful write", async () => {
  const h = harness();
  h.pr.user.login = "human";
  h.statuses = [
    {
      id: 900,
      context: policy.CONTEXT,
      state: "success",
      description:
        "Ordinary author PR: manual approval and existing required CI still apply; no dependency AUTO authorization",
      creator: { login: "other" },
    },
  ];
  await h.execute();
  assert.equal(writeCount(h), 1);
  const latest = h.statuses[0];
  assert.equal(latest.creator.login, "github-actions[bot]");
  await h.execute();
  assert.equal(writeCount(h), 1);
});

test("status-list API failure still revokes a stale success and reports the genuine failure", async () => {
  const h = harness();
  h.pr.user.login = "human";
  await h.execute();
  assert.equal(h.statuses[0].state, "success");
  h.onStatuses = () => {
    throw new Error("status list unavailable");
  };
  await h.execute();
  assert.equal(h.statuses[0].state, "failure");
  assert.ok(h.statuses[0].description.includes("status list unavailable"));
  assert.ok(h.errors.some((s) => s.includes("status list unavailable")));
  assert.equal(h.merged(), false);
});

const START = Date.UTC(2026, 0, 1);
const DAY = 24 * 60 * 60 * 1000;
const CANARY = { pr: 42, issuedAt: START, expiresAt: START + DAY };
const CANARY_HEAD = "a".repeat(40);
const CANARY_REPO = {
  owner: "tvv-lippu-ja-maksujarjestelma-oy",
  repo: "waltti-apc-mqtt-mqtt-duplicator",
};
const CANARY_WORKFLOW = `${CANARY_REPO.owner}/${CANARY_REPO.repo}/.github/workflows/dependabot-auto-approve.yml@refs/heads/main`;

function canaryHarness() {
  const h = harness();
  h.hostVerified = false;
  const setHead = (sha) => {
    h.pr.head.sha = sha;
    h.fixture.head = sha;
    h.fixture.commits[0].sha = sha;
  };
  setHead(CANARY_HEAD);
  h.setHead = setHead;
  h.observe = (canary = CANARY, options = {}) =>
    h.execute(false, {
      canary,
      now: () => START,
      policy: undefined,
      ...options,
    });
  h.invoke = ({
    approvedHead = CANARY_HEAD,
    inputs = { canary_pr: "42", approved_head: approvedHead },
    context = {},
    ...options
  } = {}) =>
    h.observe(CANARY, {
      workflowRef: CANARY_WORKFLOW,
      runAttempt: "1",
      ...options,
      context: {
        repo: CANARY_REPO,
        ref: "refs/heads/main",
        eventName: "workflow_dispatch",
        actor: "pnupu",
        payload: {
          repository: { default_branch: "main" },
          inputs,
        },
        ...context,
      },
    });
  return h;
}

function assertCanaryBlocked(h) {
  assert.equal(h.lastStatus(), "failure");
  assert.equal(
    h.calls.some(
      (c) =>
        ["merge", "dispatch"].includes(c.name) ||
        (c.name === "publish" && c.args.state === "success"),
    ),
    false,
  );
}

test("committed canary and activation are empty and legacy queue revocation still runs", async () => {
  const config = JSON.parse(
    fs.readFileSync(".github/dependency-policy/activation.json", "utf8"),
  );
  assert.equal(config.canary, null);
  assert.equal(config.enabled, false);
  assert.equal(config.hostPrerequisitesVerified, false);
  const h = canaryHarness();
  h.pr.auto_merge = { enabled: true };
  await h.execute(undefined, {
    enabled: undefined,
    hostPrerequisitesVerified: undefined,
    policy: undefined,
  });
  assert.equal(h.pr.auto_merge, null);
  assert.deepEqual(h.logs, []);
  assertCanaryBlocked(h);
  assert.equal(
    h.calls.some((c) => c.name === "files"),
    false,
  );
});

for (const [name, canary, time = START] of [
  ["empty object", {}],
  ["wrong shape", []],
  ["false", false],
  ["unknown key", { ...CANARY, other: true }],
  ["invalid PR", { ...CANARY, pr: "42" }],
  ["missing issue time", { ...CANARY, issuedAt: undefined }],
  ["future start", CANARY, START - 1],
  ["expired", CANARY, START + DAY],
  ["oversized", { ...CANARY, expiresAt: START + DAY + 1 }],
  ["obsolete config approval", { ...CANARY, mergeApproved: CANARY_HEAD }],
  ["other PR", { ...CANARY, pr: 99 }],
])
  test(`${name} canary fails closed even with general activation and attestation`, async () => {
    const h = canaryHarness();
    h.pr.auto_merge = { enabled: true };
    await h.observe(canary, {
      enabled: true,
      hostPrerequisitesVerified: true,
      now: () => time,
    });
    assert.equal(h.pr.auto_merge, null);
    assert.equal(
      h.calls.some((c) => c.name === "files"),
      false,
    );
    assert.deepEqual(h.logs, []);
    assertCanaryBlocked(h);
  });

test("a scan observes the selected PR and still revokes and blocks other dependency PRs", async () => {
  const h = canaryHarness();
  const other = {
    ...structuredClone(h.pr),
    number: 43,
    node_id: "PR43",
    head: { sha: "b".repeat(40) },
    auto_merge: { enabled: true },
  };
  h.otherPRs.set(other.number, other);
  await h.observe(CANARY, {
    context: { repo: { owner: "test", repo: "test" }, payload: {} },
  });
  assert.equal(other.auto_merge, null);
  assert.deepEqual(
    h.calls.filter((c) => c.name === "files").map((c) => c.args.pull_number),
    [42],
  );
  assert.deepEqual(h.logs, [
    `Canary PR 42 at ${CANARY_HEAD}: eligible (observation only)`,
  ]);
  assertCanaryBlocked(h);
});

test("ordinary author at the configured number retains baseline manual reporting", async () => {
  const h = canaryHarness();
  h.pr.user.login = "human";
  await h.invoke();
  assert.equal(h.lastStatus(), "success");
  assert.match(h.statuses[0].description, /^Ordinary author PR:/);
  assert.deepEqual(h.logs, []);
  assert.equal(
    h.calls.some((c) => ["files", "merge", "dispatch"].includes(c.name)),
    false,
  );
});

for (const approval of [undefined, null, "b".repeat(40)])
  test(`eligible canary only observes with merge approval ${approval}`, async () => {
    const h = canaryHarness();
    h.statuses.push({
      id: 1,
      context: policy.CONTEXT,
      creator: { login: "github-actions[bot]" },
      state: "success",
    });
    await h.invoke({ inputs: { canary_pr: "42", approved_head: approval } });
    assertCanaryBlocked(h);
    assert.equal(h.statuses[0].context, policy.CONTEXT);
    assert.equal(h.statuses[0].state, "failure");
    assert.match(h.logs[0], /: eligible \(observation only\)$/);
  });

for (const [name, invocation] of [
  ["no inputs", { inputs: {} }],
  ["wrong PR", { inputs: { canary_pr: "43", approved_head: CANARY_HEAD } }],
  [
    "noncanonical PR",
    { inputs: { canary_pr: "042", approved_head: CANARY_HEAD } },
  ],
  ["malformed SHA", { approvedHead: `${CANARY_HEAD}\n` }],
  ["untrusted actor", { context: { actor: "other" } }],
  [
    "missing actor",
    {
      context: {
        actor: undefined,
        payload: {
          repository: { default_branch: "main" },
          sender: { login: "pnupu" },
          inputs: { canary_pr: "42", approved_head: CANARY_HEAD },
        },
      },
    },
  ],
  ["missing event", { context: { eventName: undefined } }],
  ["scheduled event with inputs", { context: { eventName: "schedule" } }],
  [
    "fork repository",
    { context: { repo: { ...CANARY_REPO, owner: "another" } } },
  ],
  ["nondefault ref", { context: { ref: "refs/heads/other" } }],
  [
    "other workflow",
    {
      workflowRef: CANARY_WORKFLOW.replace("dependabot-auto-approve", "other"),
    },
  ],
  ["missing workflow identity", { workflowRef: "" }],
  [
    "changed default branch",
    {
      context: {
        payload: {
          repository: { default_branch: "other" },
          inputs: { canary_pr: "42", approved_head: CANARY_HEAD },
        },
      },
    },
  ],
  ["rerun", { runAttempt: "2" }],
  ["missing run attempt", { runAttempt: "" }],
])
  test(`canary stays in observation on ${name}`, async () => {
    const h = canaryHarness();
    await h.invoke(invocation);
    assertCanaryBlocked(h);
    assert.match(h.logs[0], /: eligible \(observation only\)$/);
    assert.equal(
      h.calls.some((c) => c.name === "repository"),
      false,
    );
  });

for (const [name, mutate] of [
  [
    "hold",
    (h) => {
      h.pr.labels = [{ name: "hold" }];
    },
  ],
  [
    "changes requested",
    (h) => {
      h.reviews = [approve("other", "CHANGES_REQUESTED")];
    },
  ],
  [
    "draft",
    (h) => {
      h.pr.draft = true;
    },
  ],
  [
    "conflict",
    (h) => {
      h.pr.mergeable = false;
    },
  ],
  [
    "behind main",
    (h) => {
      h.pr.mergeable_state = "behind";
    },
  ],
  [
    "missing required CI",
    (h) => {
      h.runs.pop();
    },
  ],
  [
    "CI from the wrong app",
    (h) => {
      h.runs[0].app.id = 999;
    },
  ],
  [
    "newer failed CI",
    (h) => {
      h.runs.push({ ...h.runs[0], id: 900, conclusion: "failure" });
    },
  ],
])
  test(`observation evaluates the ${name} veto`, async () => {
    const h = canaryHarness();
    mutate(h);
    await h.observe();
    assertCanaryBlocked(h);
    assert.match(h.logs[0], /: blocked \(observation only\)$/);
  });

for (const [name, reviews] of [
  ["stale", [approve()]],
  [
    "dismissed",
    [
      approve("pnupu", "APPROVED", CANARY_HEAD),
      approve("pnupu", "DISMISSED", CANARY_HEAD),
    ],
  ],
  ["other", [approve("other", "APPROVED", CANARY_HEAD)]],
  ["bot", [approve("pnupu", "APPROVED", CANARY_HEAD, "Bot")]],
])
  test(`HUMAN canary observation rejects ${name} reviews`, async () => {
    const h = canaryHarness();
    h.fixture.after[1].packages["node_modules/typescript"].integrity =
      "sha512-uncovered";
    assert.equal(policy.classify(h.fixture).lane, "HUMAN");
    h.reviews = reviews;
    await h.observe();
    assertCanaryBlocked(h);
    assert.match(h.logs[0], /: blocked \(observation only\)$/);
  });

test("HUMAN canary follows a new head and evaluates review independently of merge permission", async () => {
  const h = canaryHarness();
  h.fixture.after[1].packages["node_modules/typescript"].integrity =
    "sha512-uncovered";
  const newHead = "b".repeat(40);
  h.setHead(newHead);
  assert.equal(policy.classify(h.fixture).lane, "HUMAN");
  h.reviews = [approve("pnupu", "APPROVED", CANARY_HEAD)];
  await h.invoke({ approvedHead: CANARY_HEAD });
  h.reviews.push(approve("pnupu", "APPROVED", newHead));
  await h.invoke({ approvedHead: CANARY_HEAD });
  assert.deepEqual(h.logs, [
    `Canary PR 42 at ${newHead}: blocked (observation only)`,
    `Canary PR 42 at ${newHead}: eligible (observation only)`,
  ]);
  assert.equal(h.calls.filter((c) => c.name === "reviews").length, 2);
  assertCanaryBlocked(h);
});

test("an explicitly approved canary head alone can merge and dispatch after two reads", async () => {
  const h = canaryHarness();
  await h.invoke();
  assert.equal(h.lastStatus(), "success");
  assert.equal(h.calls.filter((c) => c.name === "reviews").length, 2);
  assert.equal(h.calls.filter((c) => c.name === "checks").length, 2);
  assert.equal(h.calls.find((c) => c.name === "merge").args.sha, CANARY_HEAD);
  assert.equal(h.calls.at(-1).name, "dispatch");
  assert.deepEqual(h.errors, []);
});

test("strict protection admits dispatch approval after the config commit and rebase", async () => {
  const h = canaryHarness();
  const rebasedHead = "c".repeat(40);
  h.pr.base.sha = "main-with-canary-config";
  h.pr.mergeable_state = "behind";
  await h.invoke();
  assertCanaryBlocked(h);

  h.setHead(rebasedHead);
  h.pr.mergeable_state = "clean";
  await h.invoke();
  assertCanaryBlocked(h);
  assert.match(h.logs.at(-1), /: eligible \(observation only\)$/);

  await h.invoke({ approvedHead: rebasedHead });
  assert.equal(h.pr.base.sha, "main-with-canary-config");
  assert.equal(h.calls.find((c) => c.name === "merge").args.sha, rebasedHead);
  assert.equal(h.calls.at(-1).name, "dispatch");
});

test("a single dispatch cannot authorize two attempts for a duplicated scan entry", async () => {
  const h = canaryHarness();
  h.otherPRs.set(h.pr.number, h.pr);
  h.onMerge = () => {
    throw new Error("Protected merge refused");
  };
  await h.invoke();
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );
  assert.equal(h.statuses[0].state, "failure");
});

for (const [name, mutate] of [
  [
    "late hold",
    (h) => {
      h.pr.labels = [{ name: "hold" }];
    },
  ],
  [
    "late CI failure",
    (h) => {
      h.runs[0].conclusion = "failure";
    },
  ],
  ["window expiry", (_h, expire) => expire()],
])
  test(`approved canary reread catches ${name} before merge or dispatch`, async () => {
    const h = canaryHarness();
    let now = START;
    h.onPublish = (s) => {
      if (s.state === "success")
        mutate(h, () => {
          now = START + DAY;
        });
    };
    await h.invoke({ now: () => now });
    assert.deepEqual(
      h.calls.filter((c) => c.name === "publish").map((c) => c.args.state),
      ["failure", "success", "failure"],
    );
    assert.equal(h.calls.filter((c) => c.name === "reviews").length, 2);
    assert.equal(
      h.calls.some((c) => ["merge", "dispatch"].includes(c.name)),
      false,
    );
  });

test("a second same-head bot PR blocks the merge-authorizing status", async () => {
  const h = canaryHarness();
  h.otherPRs.set(43, { ...structuredClone(h.pr), number: 43, node_id: "PR43" });
  await h.invoke();
  assertCanaryBlocked(h);
});

test("500 same-SHA ordinary and observation scans preserve the status budget for recovery", async () => {
  const h = canaryHarness();
  const bot = h.pr;
  const ordinary = {
    ...structuredClone(bot),
    number: 43,
    user: { login: "human" },
  };
  const otherBot = { ...structuredClone(bot), number: 44, node_id: "PR44" };
  h.otherPRs.set(bot.number, bot);
  h.associated = [bot];
  h.statuses.push({
    id: 1,
    context: policy.CONTEXT,
    creator: { login: "another-publisher" },
    state: "failure",
    description: "Canary policy blocks merge",
  });
  for (let scan = 0; scan < 500; scan++) {
    h.pr = bot;
    await h.observe();
    h.pr = ordinary;
    await h.observe();
    h.pr = otherBot;
    await h.observe();
  }
  assert.equal(writeCount(h), 1);
  assertCanaryBlocked(h);
  assert.deepEqual(h.errors, []);
  h.pr = bot;
  h.otherPRs.delete(bot.number);
  await h.invoke();
  assert.equal(writeCount(h), 3);
  assert.equal(h.calls.at(-1).name, "dispatch");
});

for (const mode of ["standard", "canary"])
  test(`native auto-merge could consume green before the ${mode} reread`, async () => {
    const h = canaryHarness();
    h.hostVerified = mode === "standard";
    h.repository.allow_auto_merge = true;
    h.pr.auto_merge = { enabled: true };
    let autoMerged = false;
    h.onPublish = ({ state }) => {
      // A request enabled after the first read can consume the green status
      // immediately, before the executor rereads the PR and can revoke it.
      if (state === "success" && h.repository.allow_auto_merge) {
        h.pr.state = "closed";
        autoMerged = true;
      }
    };
    if (mode === "standard") await h.observe(null, { enabled: true });
    else await h.invoke();
    assert.equal(h.pr.auto_merge, null);
    assert.equal(autoMerged, false);
    assertCanaryBlocked(h);
  });

test("500 identical protected merge refusals leave same-head dispatch retry available", async () => {
  const h = canaryHarness();
  h.onMerge = () => {
    throw new Error("403 protected merge refused");
  };
  await h.invoke();
  h.eventName = "schedule";
  for (let scan = 1; scan < 500; scan++) await h.observe();
  assert.equal(h.lastStatus(), "failure");
  assert.equal(writeCount(h), 3);
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );
  assert.ok(h.errors.some((s) => s.includes("403 protected merge refused")));
  h.onMerge = () => {};
  // Ordinary events do not retry a refused merge, even when the host recovers.
  await h.observe();
  assert.equal(writeCount(h), 3);
  await h.invoke();
  assert.equal(h.pr.head.sha, CANARY_HEAD);
  assert.equal(writeCount(h), 4);
  assert.equal(h.calls.at(-1).name, "dispatch");
});

test("observation preserves the two status slots needed for an approved retry", async () => {
  const h = canaryHarness();
  const used = 995;
  h.statuses = Array.from({ length: used }, (_, i) => ({
    id: used - i,
    sha: CANARY_HEAD,
    context: policy.CONTEXT,
    creator: { login: "other" },
    state: "failure",
  }));
  h.acceptedWrites.set(`${CANARY_HEAD}:${policy.CONTEXT}`, used);
  h.onMerge = () => {
    throw new Error("403 protected merge refused");
  };
  await h.invoke();
  const rollback = h.statuses[0];
  assert.equal(writeCount(h), 998);
  assert.equal(rollback.state, "failure");
  assert.equal(rollback.creator.login, "github-actions[bot]");
  assert.match(rollback.description, /retry via workflow_dispatch/);
  assert.ok(h.errors.some((s) => s.includes("403 protected merge refused")));

  h.onMerge = () => {};
  h.eventName = "schedule";
  await h.observe();
  await h.observe();
  assert.equal(writeCount(h), 998);
  assert.deepEqual(h.statuses[0], rollback);
  assert.match(h.logs.at(-1), /eligible \(observation only\)$/);
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );

  await h.invoke();
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 2);
  assert.equal(
    h.calls.findLast((c) => c.name === "merge").args.sha,
    CANARY_HEAD,
  );
  assert.equal(h.statuses[0].state, "success");
  assert.equal(h.calls.at(-1).name, "dispatch");
  assert.equal(writeCount(h), 999);
});

for (const mode of ["late hold", "reread API error"])
  test(`500 scans after ${mode} leave same-head dispatch retry available`, async () => {
    const h = canaryHarness();
    let publishedGreen = false;
    h.onPublish = ({ state }) => {
      if (state === "success") {
        publishedGreen = true;
        if (mode === "late hold") h.pr.labels = [{ name: "hold" }];
      }
    };
    h.onStatuses = () => {
      if (mode === "reread API error" && publishedGreen)
        throw new Error("Status API denied the fresh read");
    };
    for (let scan = 0; scan < 500; scan++) {
      publishedGreen = false;
      h.pr.labels = [];
      if (scan === 0) await h.invoke();
      else await h.observe();
    }
    assert.equal(h.lastStatus(), "failure");
    assert.equal(writeCount(h), 3);
    assert.equal(
      h.calls.some((c) => ["merge", "dispatch"].includes(c.name)),
      false,
    );
    if (mode === "reread API error")
      assert.ok(
        h.errors.some((s) => s.includes("Status API denied the fresh read")),
      );
    h.onPublish = () => {};
    h.onStatuses = () => {};
    h.pr.labels = [];
    await h.invoke();
    assert.equal(h.pr.head.sha, CANARY_HEAD);
    assert.equal(writeCount(h), 4);
    assert.equal(h.calls.at(-1).name, "dispatch");
  });

for (const retry of ["schedule", "workflow_dispatch"])
  test(`after failed rollback, ${retry} restores red before any retry`, async () => {
    const h = canaryHarness();
    let publishedGreen = false;
    h.onPublish = ({ state }) => {
      if (state === "success") {
        publishedGreen = true;
        h.pr.labels = [{ name: "hold" }];
      }
      if (state === "failure" && publishedGreen)
        throw new Error("503 writing rollback");
    };
    await h.invoke();
    assert.equal(h.statuses[0].state, "success");
    assert.equal(writeCount(h), 2);
    assert.equal(h.merged(), false);
    assert.ok(h.errors.some((s) => s.includes("Cannot revoke policy status")));

    h.onPublish = () => {};
    h.pr.labels = [];
    if (retry === "schedule") {
      h.eventName = "schedule";
      await h.observe();
    } else await h.invoke();
    if (retry === "schedule") {
      assert.equal(h.statuses[0].state, "failure");
      assert.equal(writeCount(h), 3);
      assert.equal(
        h.calls.some((c) => ["merge", "dispatch"].includes(c.name)),
        false,
      );
      await h.invoke();
    }
    assert.deepEqual(
      h.statuses.map((s) => s.state),
      ["success", "failure", "success", "failure"],
    );
    assert.equal(h.calls.find((c) => c.name === "merge").args.sha, CANARY_HEAD);
    assert.equal(h.calls.at(-1).name, "dispatch");
  });

test("a lost green write response cannot reuse a cached red status on rollback", async () => {
  const h = canaryHarness();
  h.onMerge = () => {
    throw new Error("Protected merge refused");
  };
  await h.invoke();
  assert.equal(h.statuses[0].state, "failure");
  assert.equal(writeCount(h), 3);

  h.onMerge = () => {};
  h.onPublished = ({ state }) => {
    if (state === "success") throw new Error("Lost green response");
  };
  await h.invoke();
  assert.equal(h.statuses[0].state, "failure");
  assert.equal(writeCount(h), 5);
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );
  assert.ok(h.errors.some((s) => s.includes("Lost green response")));
});

test("standard attested merge retries still accept a dispatch without canary inputs", async () => {
  const h = harness();
  h.onMerge = () => {
    throw new Error("Protected merge refused");
  };
  await h.execute();
  assert.equal(writeCount(h), 3);
  assert.equal(h.statuses[0].state, "failure");
  h.onMerge = () => {};
  h.eventName = "schedule";
  await h.execute();
  assert.equal(writeCount(h), 3);
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  h.eventName = "workflow_dispatch";
  await h.execute();
  assert.equal(writeCount(h), 4);
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 2);
  assert.equal(h.calls.at(-1).name, "dispatch");
});

test("status-write outage on green and rollback requires a manual same-head retry", async () => {
  const h = canaryHarness();
  await h.observe();
  let attemptedGreen = false;
  h.onPublish = ({ state }) => {
    if (state === "success") attemptedGreen = true;
    if (attemptedGreen) throw new Error("503 writing policy status");
  };
  await h.invoke();
  assert.equal(attemptedGreen, true);
  assert.equal(h.statuses[0].state, "failure");
  assert.equal(h.merged(), false);
  assert.ok(h.errors.some((s) => s.includes("Cannot revoke policy status")));

  h.onPublish = () => {};
  h.eventName = "schedule";
  await h.observe();
  assert.equal(h.merged(), false);
  assert.equal(h.statuses[0].state, "failure");

  await h.invoke();
  assert.deepEqual(
    h.statuses.map((s) => s.state),
    ["success", "failure", "failure"],
  );
  assert.equal(h.calls.find((c) => c.name === "merge").args.sha, CANARY_HEAD);
  assert.equal(h.calls.at(-1).name, "dispatch");
});

test("protected merge cannot authorize green before confirming its red marker", async () => {
  const h = canaryHarness();
  h.onPublish = ({ state }) => {
    if (state === "failure") throw new Error("Attempt marker write failed");
  };
  await h.invoke();
  assertCanaryBlocked(h);
  assert.equal(writeCount(h), 0);
  assert.ok(h.errors.some((s) => s.includes("Attempt marker write failed")));
});

for (const mode of ["missing", "unreadable"])
  test(`approved canary fails closed when the auto-merge setting is ${mode}`, async () => {
    const h = canaryHarness();
    h.repository = {};
    if (mode === "unreadable")
      h.onRepository = () => {
        throw new Error("Repository metadata denied");
      };
    await h.invoke();
    assertCanaryBlocked(h);
    assert.ok(
      h.errors.some((s) =>
        s.includes(
          mode === "unreadable"
            ? "Repository metadata denied"
            : "auto-merge must be explicitly disabled",
        ),
      ),
    );
  });

test("observation still evaluates and revokes a queue with native auto-merge enabled", async () => {
  const h = canaryHarness();
  h.repository.allow_auto_merge = true;
  h.pr.auto_merge = { enabled: true };
  await h.observe();
  assert.equal(h.pr.auto_merge, null);
  assertCanaryBlocked(h);
  assert.match(h.logs[0], /: eligible \(observation only\)$/);
  assert.equal(
    h.calls.some((c) => c.name === "repository"),
    false,
  );
});

test("only a trusted refusal latches retry and a manual retry still obeys CI", async () => {
  const h = canaryHarness();
  h.statuses.push({
    id: 1,
    sha: CANARY_HEAD,
    context: policy.CONTEXT,
    creator: { login: "other" },
    state: "failure",
    description:
      "Protected merge did not complete: retry via workflow_dispatch",
  });
  h.onMerge = () => ({ merged: false, message: "Protected merge rejected" });
  await h.invoke();
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  assert.ok(h.errors.some((s) => s.includes("Protected merge rejected")));
  assert.equal(h.lastStatus(), "failure");
  h.onMerge = () => {};
  h.runs[0].conclusion = "failure";
  await h.invoke();
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  assert.equal(h.lastStatus(), "failure");
  h.runs[0].conclusion = "success";
  h.eventName = "schedule";
  await h.observe();
  assert.equal(h.calls.filter((c) => c.name === "merge").length, 1);
  assert.equal(
    h.calls.some((c) => c.name === "dispatch"),
    false,
  );
});

for (const usedSlots of [998, 999])
  test(`a first protected merge needs three status slots, ${usedSlots} already used`, async () => {
    const h = canaryHarness();
    h.statuses = Array.from({ length: usedSlots }, (_, i) => ({
      id: usedSlots - i,
      sha: CANARY_HEAD,
      context: policy.CONTEXT,
      creator: { login: "other" },
      state: "failure",
    }));
    h.acceptedWrites.set(`${CANARY_HEAD}:${policy.CONTEXT}`, usedSlots);
    await h.invoke();
    assertCanaryBlocked(h);
    assert.equal(writeCount(h), usedSlots + 1);
    assert.ok(h.errors.some((s) => s.includes("Insufficient status capacity")));
  });
/* eslint-enable @typescript-eslint/no-require-imports */
