/**
 * The IPC registry: the single place a main-process capability becomes callable from the renderer.
 *
 * Each group registers through `handle()` or `listen()` below so it inherits the sender check for free,
 * and none of them may expose a raw `fetch`, a raw `spawn` or a secret's value: the renderer asks for an
 * effect, never for a credential.
 *
 * `cloud` is the group that makes the rule matter. It holds the session cookie and it takes a URL from the
 * renderer, so its own pinning — api origin, `/v1/` prefix, method allowlist — lives in
 * `cloud/ipc.ts` and runs before the jar is consulted. The sender check here is the outer of the two.
 */

import type { IpcMainEvent, IpcMainInvokeEvent, WebFrameMain } from "electron";
import { app, ipcMain, shell } from "electron";
import type { HostInfo } from "../shared/ipc.ts";
import { ipcChannels } from "../shared/ipc.ts";
import type { CloudHandlers } from "./cloud/ipc.ts";
import type { MainLog } from "./log.ts";
import { externalLinkDecision, isTrustedFrame } from "./navigation.ts";

export interface RegisterIpcOptions {
  /** The renderer origin booted in this run; any other frame is refused. */
  readonly rendererOrigin: string;
  readonly log: MainLog;
  /** The cloud transport, or null in a shell built without one (the smoke capture path). */
  readonly cloud: CloudHandlers | null;
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
}
