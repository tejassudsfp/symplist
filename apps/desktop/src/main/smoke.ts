/**
 * A screenshot-and-exit hook, gated on `SYMPLIST_DESKTOP_SMOKE_CAPTURE=<path>`.
 *
 * It exists because "the window opens and shows the frontend" is the one claim about this app that
 * cannot be made from a test runner, and an agent — or CI — has no eyes. With the variable set, the app
 * boots exactly as it normally does, writes the first painted frame to that path, and quits. Without
 * it, this module does nothing at all.
 */
import { writeFile } from "node:fs/promises";
import type { BrowserWindow } from "electron";
import type { MainLog } from "./log.ts";

export const SMOKE_CAPTURE_ENV = "SYMPLIST_DESKTOP_SMOKE_CAPTURE";

/** The capture path when a smoke run was asked for, otherwise null. */
export function smokeCapturePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[SMOKE_CAPTURE_ENV];
  return value && value.length > 0 ? value : null;
}

/** Waits for the first paint, writes a PNG of the window, and returns so the caller can quit. */
export async function captureWindow(
  window: BrowserWindow,
  targetPath: string,
  log: MainLog,
): Promise<void> {
  // A settle delay rather than a load event: fonts and the client-side first render land after
  // `did-finish-load`, and a screenshot taken before them proves less than it appears to.
  await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
  const image = await window.webContents.capturePage();
  await writeFile(targetPath, image.toPNG());
  log.info("smoke.captured", { url: window.webContents.getURL(), bytes: image.toPNG().byteLength });

  // The other half of "it works": the page can reach the bridge, which means contextIsolation, the
  // preload wrapper and the main-process sender check all line up. A renderer that renders but cannot
  // call main is the failure this catches.
  const info = (await window.webContents.executeJavaScript(
    "window.symplist ? window.symplist.host.info() : null",
  )) as { runtime?: string; assistant?: boolean } | null;
  log.info("smoke.bridge", {
    reachable: info !== null,
    runtime: info?.runtime ?? null,
    assistant: info?.assistant ?? null,
  });

  // And the half that `host.info()` cannot speak for: a real `/v1` round trip out of the renderer.
  //
  // `host.info()` is a bare `invoke` with no arguments, so it stays green even when the cloud transport
  // is completely broken — which it was, because `ApiClient` handed the bridge a `URL` and nothing but a
  // `URL` survives the context bridge as an empty object. Every request in the app became
  // "/[object Object]" and was refused for a bad origin. A status here — any status, 401 included —
  // means the URL crossed intact, main accepted it and the api answered. That is the claim worth making.
  const reach = (await window.webContents.executeJavaScript(
    `(async () => {
       const cloud = window.symplist && window.symplist.cloud;
       if (!cloud) return { ok: false, error: "no bridge" };
       try {
         const response = await cloud.fetch(cloud.apiOrigin + "/v1/me");
         return { ok: true, status: response.status };
       } catch (error) {
         return { ok: false, error: String(error && error.message ? error.message : error) };
       }
     })()`,
  )) as { ok: boolean; status?: number; error?: string };
  log.info("smoke.cloud", {
    reached: reach.ok,
    status: reach.status ?? null,
    error: reach.error ?? null,
  });

  // Why the assistant is or is not usable, which is the question asked of every build. It is read-only:
  // the three answers that matter — `harness_missing`, `key_required`, ready — are the difference
  // between a broken vendoring step, a device with no model key, and a build that can take a turn.
  const assistant = (await window.webContents.executeJavaScript(
    `window.symplist ? window.symplist.assistant.status() : null`,
  )) as { ready?: boolean; reason?: string | null } | null;
  log.info("smoke.assistant", {
    ready: assistant?.ready ?? null,
    reason: assistant?.reason ?? null,
  });
}
