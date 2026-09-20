import {
  APPEARANCE_COOKIE,
  APPEARANCE_COOKIE_MAX_AGE_SECONDS,
  type Appearance,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  serializeAppearance,
} from "./appearance.ts";
import { buildAppearanceCss } from "./css.ts";

/** The id of the `<style>` element the root layout renders with the appearance stylesheet. */
export const APPEARANCE_STYLE_ELEMENT_ID = "sym-appearance";

function cookieAttributes(doc: Document, maxAgeSeconds: number): string {
  const secure = doc.location?.protocol === "https:" ? "; Secure" : "";
  return `; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax${secure}`;
}

/**
 * Writes the non-sensitive `sym_appearance` cookie on the web origin after preferences load (§10.3).
 * Browser only: the cookie is set with `document.cookie`, never by server code.
 */
export function writeAppearanceCookie(appearance: Appearance, doc: Document = document): void {
  doc.cookie = `${APPEARANCE_COOKIE}=${serializeAppearance(appearance)}${cookieAttributes(doc, APPEARANCE_COOKIE_MAX_AGE_SECONDS)}`;
}

/** Removes the cookie on sign-out and account switch (§5.1, §10.3). */
export function removeAppearanceCookie(doc: Document = document): void {
  doc.cookie = `${APPEARANCE_COOKIE}=${cookieAttributes(doc, 0)}`;
}

/**
 * Applies an appearance to the live document without remounting anything: rewrites the appearance
 * stylesheet, then the `data-theme` and `data-mode` attributes, so drafts, editors and streaming chat
 * keep their state (note 02). Pass `persist: false` to preview without writing the cookie.
 */
export function applyAppearance(
  appearance: Appearance,
  options: { readonly persist?: boolean; readonly doc?: Document } = {},
): Appearance {
  const doc = options.doc ?? document;
  const normalized = normalizeAppearance(appearance);
  let style = doc.getElementById(APPEARANCE_STYLE_ELEMENT_ID);
  if (style?.tagName !== "STYLE") {
    style = doc.createElement("style");
    style.id = APPEARANCE_STYLE_ELEMENT_ID;
    // A new inline style needs the page's CSP nonce, which scripts rendered by Next carry.
    const nonce = doc.querySelector<HTMLScriptElement>("script[nonce]")?.nonce;
    if (nonce) style.nonce = nonce;
    doc.head.append(style);
  }
  style.textContent = buildAppearanceCss(normalized);
  doc.documentElement.dataset.theme = normalized.themeId;
  doc.documentElement.dataset.mode = normalized.mode;
  if (options.persist !== false) writeAppearanceCookie(normalized, doc);
  return normalized;
}

/** Sign-out cleanup for display state: drops the cookie and returns the document to the default look. */
export function resetAppearanceForSignOut(doc: Document = document): void {
  removeAppearanceCookie(doc);
  applyAppearance(DEFAULT_APPEARANCE, { persist: false, doc });
}
