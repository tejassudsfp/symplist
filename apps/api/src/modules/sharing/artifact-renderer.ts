import { createHash } from "node:crypto";
import type { ShareReadResult } from "@symplist/core/sharing";
import { escapeArtifactHtml as escapeHtml, renderArtifactMarkdown } from "@symplist/docs/markdown";

export const ARTIFACT_CSS = `:root{color-scheme:light dark;--bg:#fafaf9;--ink:#242424;--line:#deded9;--muted:#5d5d58}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 system-ui,sans-serif}main{max-width:760px;margin:48px auto;padding:0 28px}h1{font-size:28px;line-height:1.25;letter-spacing:-.025em;margin:0 0 16px}h2{font-size:21px;line-height:1.35;margin-top:32px}h3{font-size:17px}p,ul,ol{margin:14px 0}a{color:inherit;text-decoration:underline;text-underline-offset:3px;overflow-wrap:anywhere}header{padding-bottom:24px;border-bottom:1px solid var(--line);margin-bottom:28px}small,.meta{color:var(--muted);font-size:12px}pre{padding:16px;background:color-mix(in srgb,var(--ink) 5%,var(--bg));overflow:auto;border-radius:6px;font-size:13px}code{font-family:ui-monospace,monospace}table{display:block;overflow:auto;border-collapse:collapse}th,td{padding:8px 12px;border:1px solid var(--line)}blockquote{margin-left:0;padding-left:20px;border-left:2px solid var(--line)}input,button{font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--ink)}label{display:block;margin:20px 0 6px}button{cursor:pointer;margin-top:12px}input{max-width:100%;width:320px}a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid currentColor;outline-offset:3px}footer{border-top:1px solid var(--line);margin-top:40px;padding-top:16px}.actions{display:flex;gap:16px;flex-wrap:wrap}.notice{padding:12px;border:1px solid var(--line);border-radius:6px}@media(prefers-color-scheme:dark){:root{--bg:#202020;--ink:#e9e9e6;--line:#42423e;--muted:#b1b1a9}}@media(max-width:600px){main{margin:28px auto;padding:0 20px}h1{font-size:24px}}`;
const fontCss = ["latin", "latin-ext", "vietnamese"]
  .flatMap((subset) =>
    ["normal", "italic"].map(
      (style) =>
        `@font-face{font-family:Artifact Geist;src:url('/artifact/_assets/geist-${subset}-wght-${style}.woff2') format('woff2');font-style:${style};font-weight:100 900;font-display:swap}`,
    ),
  )
  .join("");
const css = `${fontCss}${ARTIFACT_CSS}body{font-family:Artifact Geist,system-ui,sans-serif}`;
const hash = createHash("sha256").update(css).digest("base64");
export const artifactHeaders = {
  "Content-Security-Policy": `default-src 'none'; style-src 'sha256-${hash}'; font-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
  "X-Frame-Options": "DENY",
} as const;
function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${css}</style></head><body><main>${body}<footer><small>Shared read-only with symplist</small></footer></main></body></html>`;
}
export function artifactUnavailable(tryLater = false): string {
  return page(
    "Artifact unavailable",
    `<h1>${tryLater ? "Please try later" : "This artifact is unavailable"}</h1><p>${tryLater ? "Too many attempts. Wait before trying again." : "The link may have expired or been revoked. Ask the owner for a fresh link or a downloaded copy."}</p>`,
  );
}
export function artifactPage(
  result: ShareReadResult,
  input: { artifactId: string; key?: string; publicationId?: string; invalidPassword?: boolean },
): string {
  if (result.kind === "password")
    return page(
      "Password required",
      `<h1>A password is needed</h1><p>Ask the person who shared this link for its password.</p>${input.invalidPassword ? '<p role="alert" class="notice">That password did not work. Try again.</p>' : ""}<form method="post" action="/artifact/${escapeHtml(input.artifactId)}/password"><input type="hidden" name="key" value="${escapeHtml(input.key ?? "")}"><input type="hidden" name="nonce" value="${escapeHtml(result.nonce)}"><label for="share-password">Password</label><input id="share-password" name="password" type="password" maxlength="256" autocomplete="current-password" required><div><button type="submit">Open artifact</button></div></form>`,
    );
  const raw = input.publicationId
    ? `/artifact/${input.artifactId}/public/${input.publicationId}/raw`
    : `/artifact/${input.artifactId}/raw?key=${encodeURIComponent(input.key ?? "")}`;
  return page(
    result.title,
    `<header><h1>${escapeHtml(result.title)}</h1><p class="meta">Snapshot ${escapeHtml(result.sourceRevision.slice(0, 8))} · ${escapeHtml(new Date(result.createdAt).toISOString())}${result.expiresAt ? ` · Expires ${escapeHtml(new Date(result.expiresAt).toISOString())} (UTC)` : " · Until revoked"}</p><div class="actions"><a href="${escapeHtml(raw)}">Raw Markdown</a><a href="${escapeHtml(raw)}" download="artifact.md">Download Markdown</a></div></header><article>${renderArtifactMarkdown(result.markdown)}</article>`,
  );
}
