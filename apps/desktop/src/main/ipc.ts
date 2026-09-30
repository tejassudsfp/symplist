/**
 * The IPC registry: the single place a main-process capability becomes callable from the renderer.
 *
 * Each group registers through `handle()` or `listen()` below so it inherits the sender check for free,
 * and none of them may expose a raw `fetch`, a raw `spawn` or a secret's value: the renderer asks for an
 * effect, never for a credential. `keychain` is the sharpest case — it takes the model provider key in
 * and has no channel that gives one back.
 *
 * `cloud` is the group that makes the rule matter. It holds the session cookie and it takes a URL from the
 * renderer, so its own pinning — api origin, `/v1/` prefix, method allowlist — lives in
 * `cloud/ipc.ts` and runs before the jar is consulted. The sender check here is the outer of the two.
 */

import type { IpcMainEvent, IpcMainInvokeEvent, WebFrameMain } from "electron";
import { app, ipcMain, shell } from "electron";
import type { HostInfo } from "../shared/ipc.ts";
import { ipcChannels } from "../shared/ipc.ts";
import type { AssistantService } from "./assistant-ipc.ts";
import { registerAssistantHandlers } from "./assistant-ipc.ts";
import type { CloudHandlers } from "./cloud/ipc.ts";
import type { ProviderKeyWriter } from "./keychain-ipc.ts";
import { registerKeychainHandlers } from "./keychain-ipc.ts";
import type { MainLog } from "./log.ts";
import type { McpAccess } from "./mcp/index.ts";
import { externalLinkDecision, isTrustedFrame } from "./navigation.ts";

export interface RegisterIpcOptions {
  /** The renderer origin booted in this run; any other frame is refused. */
  readonly rendererOrigin: string;
  readonly log: MainLog;
  /**
   * Whether this build carries the assistant runtime, which is what the chat slot in apps/web mounts
   * on. Not readiness: a device with a harness and no provider key still shows chat, because chat is
   * where the "add a key" state belongs.
   */
  readonly assistant: boolean;
  /**
   * The harness bridge, or null in a shell built without one (the smoke capture path, and a build
   * whose harness tree is missing). Its own argument validation lives in `assistant-ipc.ts`, because
   * every one of its arguments arrives from page script; the sender check here is the outer of the two.
   */
  readonly assistantService: AssistantService | null;
  /** The cloud transport, or null in a shell built without one (the smoke capture path). */
  readonly cloud: CloudHandlers | null;
  /**
   * The assistant's access to the workspace over Symplist MCP, or null in a shell built without it. The
   * renderer only ever reads a state and asks for a re-mint; the grant key and the relay's port stay here.
   */
  readonly mcp: McpAccess | null;
  /**
   * The store Settings → Models writes the device's model provider key into, or null in a shell built
   * without one. It is the same `SecretStore` the cloud session persists into and the same one
   * `readProviderKeys` reads from, so there is one keychain in this app and one place to audit.
   */
  readonly keychain: ProviderKeyWriter | null;
  /**
   * Called after a key is added or removed. The supervisor reads the keyring when it spawns a child, so
   * a conversation opened before the key existed is attached to a child that will never see it.
   */
  readonly onKeychainChanged?: () => void;
}

/** Raised for the renderer when a call is refused. It carries no detail the caller did not send. */
const untrusted = new Error("symplist: refused an IPC call from an untrusted frame");

export function registerIpcHandlers(options: RegisterIpcOptions): void {
  const { log, rendererOrigin } = options;

  const trusted = (channel: string, frame: WebFrameMain | null): boolean => {
    const identity = frame ? { url: frame.url, isTopFrame: frame.parent === null } : null;
    if (isTrustedFrame(identity, rendererOrigin)) return true;
    log.warn("ipc.refused", { channel, topFrame: identity?.isTopFrame ?? false });
    return false;
  };

  const handle = <Args extends readonly unknown[], Result>(
    channel: string,
    handler: (...args: Args) => Result | Promise<Result>,
  ): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!trusted(channel, event.senderFrame)) throw untrusted;
      return await handler(...(args as unknown as Args));
    });
  };

  /**
   * A fire-and-forget message. Only for effects with nothing to report back — cancelling a request in
   * flight is the one that exists — because a sender that cannot see a refusal cannot act on it.
   */
  const listen = <Args extends readonly unknown[]>(
    channel: string,
    handler: (...args: Args) => void,
  ): void => {
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (!trusted(channel, event.senderFrame)) return;
      handler(...(args as unknown as Args));
    });
  };

  handle(ipcChannels.hostInfo, (): HostInfo => {
    return {
      runtime: "desktop",
      appVersion: app.getVersion(),
      platform: process.platform,
      electronVersion: process.versions.electron,
      assistant: options.assistant,
    };
  });

  handle(ipcChannels.hostOpenExternal, async (url: unknown): Promise<boolean> => {
    if (typeof url !== "string" || externalLinkDecision(url) !== "open-externally") {
      log.warn("ipc.open_external_refused");
      return false;
    }
    await shell.openExternal(url);
    return true;
  });

  const cloud = options.cloud;
  if (cloud) {
    handle(ipcChannels.cloudRequest, (payload: unknown) => cloud.request(payload));
    listen(ipcChannels.cloudAbort, (requestId: unknown) => cloud.abort(requestId));
  }

  /*
   * Three reads and one effect, and no argument on any of them: whether the assistant's tools work, a
   * re-check, and a re-mint. The renderer cannot name a grant, cannot reach the relay, and cannot be
   * handed the key — a compromised page gets the ability to re-mint the device's own grant, which is the
   * same authority the signed-in session already has.
   */
  const mcp = options.mcp;
  if (mcp) {
    handle(ipcChannels.mcpState, () => mcp.state());
    handle(ipcChannels.mcpReconcile, () => mcp.reconcile());
    handle(ipcChannels.mcpReconnect, () => mcp.reconnect());
  }

  const assistant = options.assistantService;
  if (assistant) registerAssistantHandlers(handle, assistant, log);

  const keychain = options.keychain;
  if (keychain) {
    registerKeychainHandlers(handle, keychain, log, options.onKeychainChanged ?? (() => undefined));
  }
}
