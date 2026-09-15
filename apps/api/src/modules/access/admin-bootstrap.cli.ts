import { runAdminBootstrapCli } from "./admin-bootstrap-cli.ts";

// `pnpm --filter @symplist/api admin:bootstrap [--force-rebootstrap --actor <id> --reason <text>]`
// (§5.7), run after `tsc -b` as `node --env-file-if-exists=.env dist/modules/access/admin-bootstrap.cli.js`.
process.exitCode = await runAdminBootstrapCli(process.argv.slice(2), {
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
});
