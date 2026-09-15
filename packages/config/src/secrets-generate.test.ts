import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeGeneratedSecret,
  generatedSecretFamilies,
  secretFamilyInventory,
} from "./secrets.ts";
import { repoRoot, runSecretsGenerate, secretsGenerateScript } from "./testing/fixtures.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("pnpm secrets:generate (§16.3)", () => {
  it("is wired as the root secrets:generate script", () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts["secrets:generate"]).toBe("node scripts/secrets-generate.mjs");
  });

  it("prints _1 and _CURRENT=1 for every generated family in .env format", () => {
    const result = runSecretsGenerate();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const variables = parseEnv(result.stdout) as Record<string, string>;
    expect(Object.keys(variables).sort()).toEqual(
      generatedSecretFamilies.flatMap((family) => [`${family}_1`, `${family}_CURRENT`]).sort(),
    );
    for (const family of generatedSecretFamilies) {
      expect(variables[`${family}_CURRENT`]).toBe("1");
      const value = variables[`${family}_1`] ?? "";
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(decodeGeneratedSecret(value)).toHaveLength(32);
      expect(Buffer.from(value, "base64url").toString("base64url")).toBe(value);
    }
    for (const line of result.stdout.trimEnd().split("\n")) {
      expect(line === "" || line.startsWith("# ") || /^[A-Z][A-Z0-9_]*=\S+$/.test(line)).toBe(true);
    }
  });

  it("groups shared and api-only families so the worker gets only what it may hold", () => {
    const { stdout } = runSecretsGenerate();
    const [shared = "", apiOnly = ""] = stdout.split("# api only");
    for (const family of generatedSecretFamilies) {
      const section = secretFamilyInventory[family].worker === "yes" ? shared : apiOnly;
      expect(section).toContain(`${family}_1=`);
    }
  });

  it("generates fresh, distinct values on every run", () => {
    const first = parseEnv(runSecretsGenerate().stdout) as Record<string, string>;
    const second = parseEnv(runSecretsGenerate().stdout) as Record<string, string>;
    const values = [first, second].flatMap((run) =>
      Object.entries(run)
        .filter(([name]) => !name.endsWith("_CURRENT"))
        .map(([, value]) => value),
    );
    expect(new Set(values).size).toBe(generatedSecretFamilies.length * 2);
  });

  it("never writes files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "symplist-secrets-"));
    directories.push(cwd);
    const result = runSecretsGenerate([], cwd);
    expect(result.status).toBe(0);
    expect(readdirSync(cwd)).toEqual([]);
    const source = readFileSync(secretsGenerateScript, "utf8");
    expect(source).not.toMatch(
      /\b(?:writeFile|appendFile|createWriteStream|mkdir|copyFile|rename)\w*\s*\(/,
    );
  });

  it("rejects arguments without printing secrets", () => {
    const result = runSecretsGenerate(["--output", ".env"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("takes no arguments");
    const help = runSecretsGenerate(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).not.toMatch(/_1=/);
  });
});
