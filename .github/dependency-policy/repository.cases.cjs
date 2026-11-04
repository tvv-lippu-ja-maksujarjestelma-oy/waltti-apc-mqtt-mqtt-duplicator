/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const activation = require("./activation.json");
const { checkStates } = require("./native.cjs");
test("adoption retains exactly the actual app-bound Build and CodeQL requirements", () => {
  assert.deepEqual(activation.requiredChecks, [
    { context: "CodeQL", app_id: 57789 },
    { context: "Build, check, test, push", app_id: 15368 },
  ]);
  assert.equal(activation.enabled, false);
  assert.equal(activation.hostPrerequisitesVerified, false);
  const runs = activation.requiredChecks.map((r, id) => ({
    id,
    name: r.context,
    app: { id: r.app_id },
    status: "completed",
    conclusion: "success",
  }));
  assert.deepEqual(checkStates(activation.requiredChecks, runs, []), [
    "success",
    "success",
  ]);
  assert.deepEqual(checkStates(activation.requiredChecks, runs.slice(1), []), [
    undefined,
    "success",
  ]);
});
/* eslint-enable @typescript-eslint/no-require-imports */
