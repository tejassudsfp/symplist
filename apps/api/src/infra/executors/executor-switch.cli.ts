import { runExecutorSwitchCli } from "./executor-switch-cli.ts";
import { createTriggerRunsClient } from "./trigger-sdk-client.ts";

// `pnpm --filter @symplist/api executor:switch --to local|durable` (§8.1), run after `tsc -b`.
process.exitCode = await runExecutorSwitchCli(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  createTrigger: createTriggerRunsClient,
});
