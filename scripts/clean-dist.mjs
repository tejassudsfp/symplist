// Removes every workspace package build output (dist, including its tsbuildinfo) and the web build
// cache, so the next web build starts from the same state as a fresh clone (architecture §2.2).
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const packagesDir = join(repoRoot, "packages");

for (const name of readdirSync(packagesDir)) {
  rmSync(join(packagesDir, name, "dist"), { recursive: true, force: true });
}
rmSync(join(repoRoot, "apps", "web", ".next"), { recursive: true, force: true });
console.log("Removed packages/*/dist and apps/web/.next");
