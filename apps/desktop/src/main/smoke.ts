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

  /*
   * The same call again, but a POST that carries headers — and this one goes through `ApiClient`
   * rather than the raw bridge.
   *
   * A GET proves the URL crossed. It cannot prove the headers did, and they did not: `ApiClient`
   * builds a `Headers`, which has no own enumerable properties, so it arrived in main as `{}` with
   * no `Content-Type` and no `X-Symplist-CSRF`. Every `pre_session` route then answered 403 while
   * the GET smoke stayed green, which is how sign-in shipped broken.
   *
   * `auth/lookup` is the right probe: it is the first call sign-in makes, it needs the CSRF header,
   * and it sends no email — a 200 for an address that does not exist is the expected answer. A 403
   * means headers are not reaching the api, whatever the GET above said.
   *
   * The headers below are a plain object, which is what the web client's bridge seam now produces.
   * Passing a `Headers` would exercise the seam's own bug rather than main's handling, and the seam
   * has a unit test asserting that conversion directly.
   */
  const post = (await window.webContents.executeJavaScript(
    `(async () => {
       const cloud = window.symplist && window.symplist.cloud;
       if (!cloud) return { ok: false, error: "no bridge" };
       try {
         const response = await cloud.fetch(cloud.apiOrigin + "/v1/auth/lookup", {
           method: "POST",
           headers: {
             "Content-Type": "application/json",
             "X-Symplist-CSRF": "1",
           },
           body: JSON.stringify({ email: "smoke-probe@example.invalid" }),
         });
         return { ok: true, status: response.status };
       } catch (error) {
         return { ok: false, error: String(error && error.message ? error.message : error) };
       }
     })()`,
  )) as { ok: boolean; status?: number; error?: string };
  log.info("smoke.cloud_post", {
    reached: post.ok,
    status: post.status ?? null,
    // 403 here means the headers did not survive the bridge. That is the regression to watch.
    headers_survived: post.status !== undefined && post.status !== 403,
    error: post.error ?? null,
  });
}
