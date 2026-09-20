#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkDistributedEnvironment,
  distributeEnvironment,
  EnvironmentDistributionError,
} from "./lib/distribute-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage:",
    "  pnpm env:distribute [--source <path>]",
    "  pnpm env:check",
    "",
    "Writes apps/api/.env, apps/worker/.env and apps/web/.env with mode 600, then validates",
    "their placement and runtime schemas. Output reports names and counts only, never values.",
  ].join("\n");
}

function argumentsFor(argv) {
  let check = false;
  let sourcePath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--source") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new EnvironmentDistributionError("--source needs a path");
      }
      sourcePath = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { help: true };
    throw new EnvironmentDistributionError("Unknown option; use --help for supported arguments");
  }
  if (check && sourcePath) {
    throw new EnvironmentDistributionError("--source cannot be used with --check");
  }
  return { check, sourcePath };
}

try {
  const options = argumentsFor(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
  } else if (options.check) {
    const result = await checkDistributedEnvironment({ repoRoot });
    process.stdout.write(
      `Environment placement and configuration valid: api ${result.assignments.api}, worker ${result.assignments.worker}, web ${result.assignments.web} assignments.\n`,
    );
  } else {
    const result = await distributeEnvironment({
      repoRoot,
      ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    });
    process.stdout.write(
      `Environment distributed and validated: api ${result.assignments.api}, worker ${result.assignments.worker}, web ${result.assignments.web} assignments; ${result.sourceOnlyCount} source-only assignments kept out.\n`,
    );
  }
} catch (error) {
  const message =
    error instanceof EnvironmentDistributionError
      ? error.message
      : "Environment distribution failed; no value was printed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
