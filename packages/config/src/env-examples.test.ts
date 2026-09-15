import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { apiSecretFamilies, apiVariableNames, loadApiConfig } from "./api.ts";
import { isSecretVariable } from "./secrets.ts";
import { readEnvExample, runSecretsGenerate } from "./testing/fixtures.ts";
import { loadWebConfig, webVariableNames } from "./web.ts";
import { loadWorkerConfig, workerSecretFamilies, workerVariableNames } from "./worker.ts";

/** Fresh generated family values, from the real `pnpm secrets:generate` script. */
function generatedFamilies(): Record<string, string> {
  const result = runSecretsGenerate();
  expect(result.status).toBe(0);
  return parseEnv(result.stdout) as Record<string, string>;
}

/** Fills each empty `<FAMILY>_<n>` line of an example with a generated value. */
function fillSecrets(variables: Record<string, string>, generated: Record<string, string>) {
  const filled = { ...variables };
  for (const [name, value] of Object.entries(variables)) {
    if (value === "" && /_[1-9][0-9]*$/.test(name) && generated[name] !== undefined) {
      filled[name] = generated[name];
    }
  }
  return filled;
}

function expectedNames(fixed: readonly string[], families: readonly string[]) {
  return [...fixed, ...families.flatMap((family) => [`${family}_1`, `${family}_CURRENT`])].sort();
}

/** Every assignment line is directly preceded by a comment line. */
function uncommentedAssignments(text: string): string[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    if (!/^[A-Z][A-Z0-9_]*=/.test(line)) return [];
    const previous = lines[index - 1] ?? "";
    return previous.startsWith("#") ? [] : [line.slice(0, line.indexOf("="))];
  });
}

describe.each([
  {
    app: "api" as const,
    names: expectedNames(apiVariableNames, apiSecretFamilies),
    load: (env: Record<string, string>) => loadApiConfig(env),
  },
  {
    app: "worker" as const,
    names: expectedNames(
      workerVariableNames.filter((name) => name !== "TRIGGER_SECRET_KEY"),
      workerSecretFamilies,
    ),
    load: (env: Record<string, string>) => loadWorkerConfig(env),
  },
  {
    app: "web" as const,
    names: [...webVariableNames].sort(),
    load: (env: Record<string, string>) => loadWebConfig(env),
  },
])("apps/$app/.env.example", ({ app, names, load }) => {
  const { text, variables } = readEnvExample(app);

  it("lists every variable the runtime reads, and nothing else", () => {
    expect(Object.keys(variables).sort()).toEqual(names);
  });

  it("documents every variable with a comment", () => {
    expect(uncommentedAssignments(text)).toEqual([]);
  });

  it("holds no secret values", () => {
    const withValues = Object.entries(variables).filter(
      ([name, value]) => isSecretVariable(name) && !name.endsWith("_CURRENT") && value !== "",
    );
    expect(withValues).toEqual([]);
  });

  it("uses the local development defaults", () => {
    if (app === "web") {
      expect(variables.NEXT_PUBLIC_API_URL).toBe("http://localhost:4000");
      return;
    }
    expect(variables).toMatchObject({
      DATA_DRIVER: "local",
      EMAIL_DRIVER: "log",
      DURABLE: "false",
    });
  });

  it("parses once the secrets are filled with generated values", () => {
    const generated = generatedFamilies();
    const config = load(fillSecrets(variables, generated));
    expect(config).toBeTruthy();
  });
});

describe("example consistency", () => {
  it("never lists TRIGGER_SECRET_KEY for the worker, which Trigger.dev injects", () => {
    expect(readEnvExample("worker").variables).not.toHaveProperty("TRIGGER_SECRET_KEY");
  });

  it("shares one set of generated family values between the api and worker examples", () => {
    const generated = generatedFamilies();
    const api = loadApiConfig(fillSecrets(readEnvExample("api").variables, generated));
    const worker = loadWorkerConfig(fillSecrets(readEnvExample("worker").variables, generated));
    for (const family of workerSecretFamilies) {
      expect(worker[family as "CONTENT_KEK"].versions.get(1)).toBe(
        api[family as "CONTENT_KEK"].versions.get(1),
      );
    }
  });
});
