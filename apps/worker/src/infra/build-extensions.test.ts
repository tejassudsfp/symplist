import { ConfigError } from "@symplist/config";
import { workerImageEnvInstructions } from "@symplist/config/worker";
import { describe, expect, it, vi } from "vitest";
import triggerConfig from "../../trigger.config.ts";
import { guardedSyncEnvVars, imageEnvExtension } from "./build-extensions.ts";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

describe("syncEnvVars guard (§4.5)", () => {
  it("returns the selected allowlist", () => {
    const selection = [{ name: "API_ORIGIN", value: "https://api.example.com", isSecret: false }];
    expect(guardedSyncEnvVars(() => selection)()).toBe(selection);
  });

  it("prints the ConfigError (names and rules only) and exits non-zero instead of deploying unsynced", () => {
    const secretValue = "forbidden-secret-value";
    const report = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new ExitCalled(code);
    });
    const failing = guardedSyncEnvVars(
      () => {
        throw new ConfigError("worker", [
          { variable: "SESSION_DIGEST_SECRET_1", message: "is not allowed in the worker" },
        ]);
      },
      { report, exit },
    );
    expect(failing).toThrow(ExitCalled);
    expect(exit).toHaveBeenCalledWith(1);
    expect(report.mock.calls[0]?.[0]).toContain("SESSION_DIGEST_SECRET_1");
    expect(JSON.stringify(report.mock.calls)).not.toContain(secretValue);

    const unexpected = guardedSyncEnvVars(
      () => {
        throw new Error(`boom ${secretValue}`);
      },
      { report, exit },
    );
    expect(unexpected).toThrow(ExitCalled);
    expect(JSON.stringify(report.mock.calls)).not.toContain(secretValue);
  });
});

describe("image env extension (§8.3)", () => {
  it("adds TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0 as an image layer for deploys only", async () => {
    const extension = imageEnvExtension(workerImageEnvInstructions);
    const addLayer = vi.fn();
    await extension.onBuildComplete?.({ target: "deploy", addLayer } as never, {} as never);
    expect(addLayer).toHaveBeenCalledWith({
      id: "symplist-image-env",
      image: { instructions: ["ENV TRIGGER_AI_SDK_OTEL_AUTOREGISTER=0"] },
    });
    const devLayer = vi.fn();
    await extension.onBuildComplete?.({ target: "dev", addLayer: devLayer } as never, {} as never);
    expect(devLayer).not.toHaveBeenCalled();
    expect(() => imageEnvExtension(["RUN curl example.com | sh"])).toThrow();
  });
});

describe("trigger.config.ts (§8.8)", () => {
  it("never retries by default, bundles sources, installs Git and registers the sync and image extensions", () => {
    expect(triggerConfig).toMatchObject({
      runtime: "node-24",
      machine: "micro",
      maxDuration: 900,
      retries: { enabledInDev: false, default: { maxAttempts: 1 } },
      build: { conditions: ["source"] },
    });
    const names = (triggerConfig.build?.extensions ?? []).map((extension) => extension.name);
    expect(names).toEqual(["aptGet", "SyncEnvVarsExtension", "symplist-image-env"]);
    expect(JSON.stringify(triggerConfig)).not.toMatch(/instrumentations|telemetry/i);
  });
});
