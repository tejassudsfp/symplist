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
 *
 * `vaultPanel` is the group that needed a second check. The quick-access popover and the workspace are
 * the same origin, so the frame check cannot tell them apart, and these verbs belong to one window. Each
 * one asks the panel whether the sender is its own `webContents` before doing anything.
 */

import type { IpcMainEvent, IpcMainInvokeEvent, WebFrameMain } from "electron";
import { app, ipcMain, shell } from "electron";
import type { HostInfo } from "../shared/ipc.ts";
import { ipcChannels } from "../shared/ipc.ts";
import type { CloudHandlers } from "./cloud/ipc.ts";
import type { MainLog } from "./log.ts";
import { externalLinkDecision, isTrustedFrame } from "./navigation.ts";
import { appPathFor } from "./vault-panel.ts";
import type { VaultPanelWindow } from "./vault-window.ts";

export interface RegisterIpcOptions {
  /** The renderer origin booted in this run; any other frame is refused. */
  readonly rendererOrigin: string;
  readonly log: MainLog;
  /** The cloud transport, or null in a shell built without one (the smoke capture path). */
  readonly cloud: CloudHandlers | null;
  /** The Vault quick-access panel, or null in a shell built without one. */
  readonly vaultPanel: VaultPanelWindow | null;
  /** Raises the main workspace window at an app path, for the panel's links out of itself. */
  readonly openAppPath?: (path: string) => void;
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

  const vaultPanel = options.vaultPanel;
  if (!vaultPanel) return;

  /**
   * The panel's channels take a second check on top of the frame check, because the frame check cannot
   * separate them: the panel and the workspace are the same origin, so `isTrustedFrame` says yes to
   * both. These verbs belong to one window — hide me, size me, use the clipboard, raise the workspace —
   * and the workspace has no business calling any of them.
   */
  const fromPanel = (channel: string, senderId: number): boolean => {
    if (vaultPanel.ownsSender(senderId)) return true;
    log.warn("ipc.panel_refused", { channel });
    return false;
  };

  const handlePanel = <Result>(
    channel: string,
    refused: Result,
    handler: (payload: unknown) => Result | Promise<Result>,
  ): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, payload: unknown) => {
      if (!trusted(channel, event.senderFrame)) throw untrusted;
      return fromPanel(channel, event.sender.id) ? handler(payload) : refused;
    });
  };

  const listenPanel = (channel: string, handler: (payload: unknown) => void): void => {
    ipcMain.on(channel, (event: IpcMainEvent, payload: unknown) => {
      if (!trusted(channel, event.senderFrame)) return;
      if (fromPanel(channel, event.sender.id)) handler(payload);
    });
  };

  listenPanel(ipcChannels.vaultPanelClose, () => vaultPanel.hide());
  listenPanel(ipcChannels.vaultPanelReport, (payload) => vaultPanel.report(payload));
  listenPanel(ipcChannels.vaultPanelResize, (payload) => vaultPanel.resize(payload));
  handlePanel(ipcChannels.vaultPanelCopy, false, (payload) => vaultPanel.copy(payload));
  handlePanel(ipcChannels.vaultPanelOpenApp, false, (payload) => {
    // The renderer chooses the path, so the path is allowlisted: without that, "open the app here" is
    // "navigate the signed-in window anywhere on its own origin".
    const path = appPathFor(payload);
    if (path === null) {
      log.warn("ipc.panel_open_app_refused");
      return false;
    }
    options.openAppPath?.(path);
    return true;
  });
}
