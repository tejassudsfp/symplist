import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("production migrations wait for every verification lane and use only the CI token", () => {
  const start = workflow.indexOf("  migrate:\n");
  assert.notEqual(start, -1);
  const job = workflow.slice(start);
  assert.match(job, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/);
  assert.match(job, /needs: \[verify, e2e, api-image\]/);
  assert.match(job, /environment: production/);
  assert.match(
    job,
    /CLOUDFLARE_D1_MIGRATE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_D1_MIGRATE_API_TOKEN \}\}/,
  );
  assert.doesNotMatch(job, /CLOUDFLARE_D1_(?:API_TOKEN|WORKER_API_TOKEN):/);
  assert.match(job, /node packages\/db\/src\/cli\/migrate\.ts --driver d1/);
});

test("CI leaves Trigger deployment to the linked repository", () => {
  assert.doesNotMatch(workflow, /^ {2}deploy-trigger:/m);
});
