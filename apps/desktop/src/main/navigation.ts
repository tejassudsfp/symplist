/**
 * What the renderer is allowed to navigate to, and what leaves for the system browser.
 *
 * The renderer holds no session (§ the desktop's cloud client runs in main), but it does render
 * user-authored Markdown with links in it. A click that navigated the window itself to a remote page
 * would put that page on the renderer's own origin, next to the preload bridge. So the window never
 * leaves the local origin, and anything else is either handed to the operating system or refused.
 *
 * These are pure string predicates on purpose: the Electron wiring in `window.ts` stays a few lines,
 * and the policy is unit-tested without a browser.
 */

/** Schemes that may be handed to the user's default application. */
const externalSchemes = new Set(["http:", "https:", "mailto:"]);

function parse(target: string): URL | null {
  try {
    return new URL(target);
  } catch {
    return null;
  }
}

/**
 * True when `target` is a page of the renderer's own origin — the loopback Next server in a packaged
 * app, or the `next dev` server in development.
 */
export function isInternalUrl(target: string, rendererOrigin: string): boolean {
  const url = parse(target);
  const origin = parse(rendererOrigin);
  if (!url || !origin) return false;
  // `origin` is compared rather than host so a downgrade to http: on an https: dev server is refused.
  return url.origin === origin.origin;
}

/** What to do with a link the renderer tried to open outside its own origin. */
export type ExternalLinkDecision = "open-externally" | "deny";

/**
 * Decides whether a link may reach the operating system. Only http, https and mailto do: `file:`
 * would read the user's disk on a click, and `javascript:` or a registered custom scheme would run
 * code chosen by whoever wrote the document.
 */
export function externalLinkDecision(target: string): ExternalLinkDecision {
  const url = parse(target);
  if (!url) return "deny";
  return externalSchemes.has(url.protocol) ? "open-externally" : "deny";
}

/** The part of an Electron frame the trust decision depends on. */
export interface FrameIdentity {
  readonly url: string;
  /** Electron's `WebFrameMain.parent === null`. A subframe never speaks for the app. */
  readonly isTopFrame: boolean;
}

/**
 * Whether an IPC message may be served. Electron delivers `ipcMain` messages from any frame of any
 * loaded page, including an iframe of a remote document, and the bridge reaches the cloud session and
 * the OS keychain — so the check is the top frame of our own origin, and nothing else.
 */
export function isTrustedFrame(frame: FrameIdentity | null, rendererOrigin: string): boolean {
  if (!frame?.isTopFrame) return false;
  return isInternalUrl(frame.url, rendererOrigin);
}
