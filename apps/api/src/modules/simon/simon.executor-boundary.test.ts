import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SimonLifecycle } from "./simon.module.ts";

function lifecycle(durable: boolean) {
  const registerLocalHandler = vi.fn();
  const args = [
    {},
    { DURABLE: durable },
    { registerLocalHandler },
    {},
    {},
    {},
    {},
    {},
    {},
  ] as unknown as ConstructorParameters<typeof SimonLifecycle>;
  return { value: new SimonLifecycle(...args), registerLocalHandler };
}

describe("Simon executor boundary", () => {
  it("does not install a model/tool handler in the durable API", () => {
    const instance = lifecycle(true);
    instance.value.onModuleInit();
    expect(instance.registerLocalHandler).not.toHaveBeenCalled();
  });

  it("keeps local execution lazy and free of Trigger SDK calls", () => {
    const instance = lifecycle(false);
    instance.value.onModuleInit();
    expect(instance.registerLocalHandler).toHaveBeenCalledTimes(1);
    expect(instance.registerLocalHandler.mock.calls[0]?.[0]).toBe("simon_run");

    const local = readFileSync(new URL("./simon.local.ts", import.meta.url), "utf8");
    expect(local).toContain('await import("@symplist/agent")');
    expect(local).not.toContain("@trigger.dev/");
    expect(local).not.toContain("tasks.trigger");

    const connections = readFileSync(new URL("./simon.connections.ts", import.meta.url), "utf8");
    expect(connections).toContain('from "@symplist/agent/policy"');
    expect(connections).not.toMatch(/from ["']@symplist\/agent["']/);

    const moduleSource = readFileSync(new URL("./simon.module.ts", import.meta.url), "utf8");
    expect(moduleSource).not.toContain("../connections/");
  });
});
