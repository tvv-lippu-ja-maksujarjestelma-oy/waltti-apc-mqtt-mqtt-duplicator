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
    fixture,
    calls: [],
    errors: [],
    warnings: [],
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
    onMerge: () => {},
    onDispatch: () => {},
    onRevoke: () => {},
    onStatuses: () => {},
  };
  let reads = 0;
  const api = (name, fn) => async (args) => {
    h.calls.push({ name, args });
    return { data: await fn(args) };
  };
  const github = {
    rest: {
      pulls: {
        list: api("list", () => [h.pr]),
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
          h.onMerge(args);
          return { merged: true, sha: "merged" };
        }),
      },
      repos: {
        getBranchProtection: api("protection", () => h.protection),
        listPullRequestsAssociatedWithCommit: api(
          "associated",
          () => h.associated,
        ),
        getContent: api("content", ({ ref, path }) => ({
          encoding: "base64",
          content: Buffer.from(
            JSON.stringify(
              h.fixture[ref === "base" ? "before" : "after"][
                path === "package.json" ? 0 : 1
              ],
            ),
          ).toString("base64"),
        })),
        listCommitStatusesForRef: api("statuses", () => {
          h.onStatuses();
          return h.statuses;
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
      h.pr.auto_merge = null;
    },
    paginate: async (method, args) => (await method(args)).data,
  };
  h.execute = (enabled = true) =>
    run({
      github,
      context: {
        repo: { owner: "test", repo: "test" },
        payload: { pull_request: structuredClone(h.pr) },
      },
      core: {
        info: () => {},
        warning: (s) => h.warnings.push(s),
        setFailed: (s) => h.errors.push(s),
      },
      policy,
      enabled,
      hostPrerequisitesVerified: h.hostVerified,
      requiredChecks: h.protection.required_status_checks.checks.filter(
        (c) => c.context !== policy.CONTEXT,
      ),
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
    assert.equal(writeCount(h), 2);
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
/* eslint-enable @typescript-eslint/no-require-imports */
