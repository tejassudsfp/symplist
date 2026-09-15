/**
 * Link destinations allowed when rendering untrusted Markdown (§10.4): absolute `https:` URLs without
 * credentials and `mailto:` addresses. Identical to the web's `SafeMarkdown` rule.
 */
export interface SafeDestination {
  readonly href: string;
  /** What the reader sees before following the link: a host, or an email address. */
  readonly display: string;
  readonly kind: "https" | "mailto";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point.
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Allows only absolute `https:` URLs without credentials and `mailto:` addresses. Relative,
 * protocol-relative, `http:`, `javascript:`, `data:` and every other scheme are refused.
 */
export function safeDestination(raw: string | null | undefined): SafeDestination | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048 || controlCharacters.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol === "https:") {
    if (url.username || url.password || !url.hostname) return null;
    return { href: url.href, display: url.hostname, kind: "https" };
  }
  if (url.protocol === "mailto:") {
    let address: string;
    try {
      address = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
    if (!/^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+$/.test(address)) return null;
    return { href: url.href, display: address, kind: "mailto" };
  }
  return null;
}
