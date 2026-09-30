import { describe, expect, it, vi } from "vitest";
import { keychainChannels } from "../shared/keychain.ts";
import { providerKeySecretName } from "./harness/provider-keys.ts";
import type { ProviderKeyWriter } from "./keychain-ipc.ts";
import { registerKeychainHandlers } from "./keychain-ipc.ts";
import type { MainLog } from "./log.ts";

/*
 * The property that matters most here cannot be asserted by calling a channel: it is that no channel
 * returns a key. So the registered channel names are checked against the whole group, and every answer
 * is checked to be a status and nothing more — a future "read" channel would have to break one of them.
 */
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as MainLog;

function store(initial: Record<string, string> = {}, available = true) {
  const values = new Map(Object.entries(initial));
  const writer: ProviderKeyWriter = {
    isAvailable: () => available,
    read: (name) => values.get(name) ?? null,
    write: (name, plainText) => {
      values.set(name, plainText);
      return true;
    },
    clear: (name) => {
      values.delete(name);
    },
  };
  return { writer, values };
}

function registered(writer: ProviderKeyWriter, onChanged = vi.fn()) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerKeychainHandlers(
    (channel, handler) => {
      handlers.set(channel, handler as unknown as (...args: unknown[]) => unknown);
    },
    writer,
    log,
    onChanged,
  );
  return {
    handlers,
    onChanged,
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)?.(...args),
  };
}

describe("the keychain IPC group", () => {
  it("registers exactly the three channels the group declares", () => {
    const { handlers } = registered(store().writer);
    expect([...handlers.keys()].sort()).toEqual(Object.values(keychainChannels).sort());
  });

  it("reports which providers hold a key without ever returning one", () => {
    const { writer } = store({ [providerKeySecretName.openai]: "sk-live" });
    const { call } = registered(writer);
    const status = call(keychainChannels.keychainStatus);
    expect(status).toEqual({ available: true, providers: { openai: true, anthropic: false } });
    // The stored value appears nowhere in the answer, at any depth.
    expect(JSON.stringify(status)).not.toContain("sk-live");
  });

  it("stores a key under the name the reader looks for", () => {
    // The writer and `readProviderKeys` agree through `providerKeySecretName`; a key written under any
    // other name is a key the harness will never find, and the user would see "add a key" forever.
    const { writer, values } = store();
    const { call } = registered(writer);
    call(keychainChannels.keychainSet, "anthropic", "sk-ant-123");
    expect(values.get(providerKeySecretName.anthropic)).toBe("sk-ant-123");
  });

  it("trims a pasted key, because a trailing newline is the usual way one arrives", () => {
    const { writer, values } = store();
    const { call } = registered(writer);
    call(keychainChannels.keychainSet, "openai", "  sk-live\n");
    expect(values.get(providerKeySecretName.openai)).toBe("sk-live");
  });

  it("refuses an unknown provider, a blank key and an absurd one", () => {
    const { writer, values } = store();
    const { call, onChanged } = registered(writer);
    call(keychainChannels.keychainSet, "bedrock", "sk-live");
    call(keychainChannels.keychainSet, "openai", "   ");
    call(keychainChannels.keychainSet, "openai", "k".repeat(4_097));
    expect(values.size).toBe(0);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("counts a blank stored value as absent, exactly as the reader does", () => {
    // `readProviderKeys` treats a blank as missing, so a status that called it present would offer no
    // way out of a turn that fails with a provider error.
    const { writer } = store({ [providerKeySecretName.openai]: "   " });
    const { call } = registered(writer);
    expect(call(keychainChannels.keychainStatus)).toMatchObject({
      providers: { openai: false },
    });
  });

  it("removes a key and says so", () => {
    const { writer, values } = store({ [providerKeySecretName.openai]: "sk-live" });
    const { call, onChanged } = registered(writer);
    const status = call(keychainChannels.keychainClear, "openai");
    expect(values.has(providerKeySecretName.openai)).toBe(false);
    expect(status).toMatchObject({ providers: { openai: false } });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("tells the renderer when the machine has no keychain at all", () => {
    // Without `safeStorage` a key could only be kept as plaintext, which this app never does. The UI
    // needs to say that rather than let the user retype a key on every launch and wonder why.
    const { writer } = store({ [providerKeySecretName.openai]: "sk-live" }, false);
    const { call } = registered(writer);
    expect(call(keychainChannels.keychainStatus)).toEqual({
      available: false,
      providers: { openai: false, anthropic: false },
    });
  });

  it("asks for a harness restart only when something actually changed", () => {
    // The restart drops every child, so firing it on a refused write would kill a running turn for
    // nothing.
    const { writer } = store();
    const { call, onChanged } = registered(writer);
    call(keychainChannels.keychainSet, "openai", "sk-live");
    expect(onChanged).toHaveBeenCalledTimes(1);
    call(keychainChannels.keychainSet, "openai", "");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
