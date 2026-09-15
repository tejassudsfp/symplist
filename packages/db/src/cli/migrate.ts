#!/usr/bin/env node
/**
 * `pnpm db:migrate`: applies pending migrations to D1 or the local SQLite file (§3.4). Runs from
 * source with Node's type stripping, or from `dist/cli/migrate.js` after a build.
 */
import { runMigrateCli } from "../migrate-cli.ts";

process.exitCode = await runMigrateCli(process.argv.slice(2), process.env, {
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
});
