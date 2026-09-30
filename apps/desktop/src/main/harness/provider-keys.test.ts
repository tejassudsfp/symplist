import { describe, expect, it, vi } from "vitest";
import type { MainLog } from "../log.ts";
import { silentMainLog } from "../log.ts";
import { providerKeySecretName, readProviderKeys } from "./provider-keys.ts";

function store(values: Readonly<Record<string, string>>, available = true) {
  return {
    isAvailable: () => available,
    read: (name: string) => values[name] ?? null,
  };
}

describe("readProviderKeys", () => {
  it("reads each provider's key under its stable stored name", () => {
    const keys = readProviderKeys(
      store({
        [providerKeySecretName.openai]: "sk-a",
        [providerKeySecretName.anthropic]: "sk-ant-b",
      }),
      silentMainLog,
    );
    expect(keys).toEqual({ openai: "sk-a", anthropic: "sk-ant-b" });
  });

  it("treats a blank stored value as absent", () => {
    // An empty `apiKeyEnv` reference fails a request with MISSING_CREDENTIAL deep inside a turn;
    // absence here means the route is never emitted and the user is told to add a key first.
    expect(
      readProviderKeys(store({ [providerKeySecretName.openai]: "   " }), silentMainLog),
    ).toEqual({});
  });

  it("answers nothing when the keychain is unavailable", () => {
    expect(
      readProviderKeys(store({ [providerKeySecretName.openai]: "sk-a" }, false), silentMainLog),
    ).toEqual({});
  });

  it("logs the count and never a key or its length", () => {
    const fields: unknown[] = [];
    const log: MainLog = { ...silentMainLog, info: vi.fn((_event, given) => fields.push(given)) };
    readProviderKeys(store({ [providerKeySecretName.openai]: "sk-secret-value" }), log);
    expect(fields).toEqual([{ count: 1 }]);
    expect(JSON.stringify(fields)).not.toContain("sk-secret-value");
  });
});
