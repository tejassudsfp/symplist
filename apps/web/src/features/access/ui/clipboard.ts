/**
 * Copies text with the async Clipboard API. Resolves false when the browser refuses (no permission,
 * insecure context, no API), so the screen can say the copy failed and leave the text selectable.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
