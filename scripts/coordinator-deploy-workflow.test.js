import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflow = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "coordinator-deploy.yml"),
  "utf8",
);

test("coordinator deploy syncs a configured Daytona snapshot", () => {
  assert.match(
    workflow,
    /CRABBOX_DAYTONA_SNAPSHOT: \$\{\{ secrets\.CRABBOX_DAYTONA_SNAPSHOT \}\}/,
  );
  assert.match(workflow, /\[ -n "\$\{CRABBOX_DAYTONA_SNAPSHOT\}" \]/);
  assert.match(
    workflow,
    /printf '%s' "\$\{CRABBOX_DAYTONA_SNAPSHOT\}" \|\s+npx wrangler secret put CRABBOX_DAYTONA_SNAPSHOT/,
  );
});

test("coordinator deploy preserves account-default mode when no snapshot is configured", () => {
  assert.match(
    workflow,
    /CRABBOX_DAYTONA_SNAPSHOT is not set; keeping the Daytona account-default mode/,
  );
  assert.doesNotMatch(
    workflow,
    /CRABBOX_DAYTONA_SNAPSHOT is not set[^]*?exit 1/,
  );
});

test("manual deploy can explicitly clear a stale Daytona snapshot binding", () => {
  assert.match(workflow, /^      clearDaytonaSnapshot:$/m);
  assert.match(workflow, /type: boolean/);
  assert.match(
    workflow,
    /CLEAR_DAYTONA_SNAPSHOT: \$\{\{ inputs\.clearDaytonaSnapshot \}\}/,
  );
  assert.match(
    workflow,
    /printf '\{"CRABBOX_DAYTONA_SNAPSHOT":null\}\\n' \|\s+npx wrangler secret bulk/,
  );
});
