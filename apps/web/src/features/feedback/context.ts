import type { BugReportSurface } from "@symplist/contracts";
import { runningInDesktopShell } from "@/lib/api";

/**
 * The context a bug report carries beside what somebody typed: which surface they were on, the route,
 * the build and the platform. Everything here is read from the page, never typed by the reporter, and
 * is stored in the clear — a report nobody can place is a report nobody can act on.
 */
export interface ReportContext {
  readonly surface: BugReportSurface;
  readonly page?: string;
  readonly appVersion?: string;
  readonly platform?: string;
}

/**
 * The desktop shell's host bridge, matched structurally for the same reason the api transport is:
 * `apps/web` must not depend on `apps/desktop`.
 */
interface DesktopHostBridge {
  info(): Promise<{ readonly appVersion?: unknown; readonly platform?: unknown }>;
}

function desktopHost(): DesktopHostBridge | null {
  const host = (globalThis as { symplist?: { host?: unknown } }).symplist?.host;
  if (typeof host !== "object" || host === null) return null;
  const candidate = host as { info?: unknown };
  return typeof candidate.info === "function" ? (host as DesktopHostBridge) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Where the reporter is, as far as the page can tell.
 *
 * `page` is the pathname and nothing else: a query string or a fragment can carry a search somebody
 * typed, and a bug report is not the place to collect it. `appVersion` and `platform` come from the
 * desktop shell when there is one; a browser leaves them out, because it knows neither and the api
 * records the user agent anyway.
 *
 * `signedOut` is the one thing the caller knows and this cannot: a visitor on the public site is
 * reporting from `site` whether or not that page happens to be inside the app's own routes.
 */
export async function describeContext(
  options: { readonly signedOut?: boolean } = {},
): Promise<ReportContext> {
  const page = typeof location === "undefined" ? undefined : text(location.pathname);
  const host = desktopHost();
  if (!host || !runningInDesktopShell()) {
    return { surface: options.signedOut ? "site" : "workspace", ...(page ? { page } : {}) };
  }
  // A shell that cannot answer still gives a desktop report: knowing which app it came from matters
  // more than the version, and the whole point of the dialog is that it works when things do not.
  const info = await host.info().catch(() => null);
  return {
    surface: "desktop",
    ...(page ? { page } : {}),
    ...(text(info?.appVersion) ? { appVersion: text(info?.appVersion) } : {}),
    ...(text(info?.platform) ? { platform: text(info?.platform) } : {}),
  };
}
