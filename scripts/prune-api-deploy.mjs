// Removes TypeScript-only build outputs (.d.ts, .d.ts.map, .tsbuildinfo) from an api deploy directory
// made by `pnpm --filter @symplist/api --prod deploy <dir>`: from the api's dist and from every
// injected workspace package's dist. The image runs JavaScript only (decision CZB.3), so this is the
// last build step of apps/api/Dockerfile, and scripts/check-api-deploy.mjs checks its result.
//
// Usage: node scripts/prune-api-deploy.mjs <deploy directory>
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pruneDeclarationOutputs } from "./lib/api-deploy.mjs";

const args = process.argv.slice(2);
if (args.length !== 1) {
  process.stderr.write("Usage: node scripts/prune-api-deploy.mjs <deploy directory>\n");
  process.exitCode = 2;
} else {
  const deployDir = resolve(args[0]);
  if (!existsSync(join(deployDir, "dist", "main.js"))) {
    process.stderr.write(`prune-api-deploy: ${deployDir} is not an api deploy (no dist/main.js)\n`);
    process.exitCode = 1;
  } else {
    const removed = pruneDeclarationOutputs(deployDir);
    process.stdout.write(`prune-api-deploy: removed ${removed.length} declaration output(s)\n`);
  }
}
