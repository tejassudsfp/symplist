/** One indexed piece of a section body and where it starts in the section text. */
export interface TextChunk {
  readonly start: number;
  readonly text: string;
}

const whitespace = /\s/;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Splits a long text into overlapping chunks at whitespace (§10.1 long documents). Each chunk is at
 * most `chunkChars` long; consecutive chunks share up to `overlapChars` so a phrase that crosses a
 * boundary is still contiguous in one chunk. Deterministic for a given text and limits. An empty text
 * yields one empty chunk, so a heading-only section is still indexed.
 */
export function chunkText(
  text: string,
  options: { readonly chunkChars: number; readonly overlapChars: number },
): TextChunk[] {
  const { chunkChars, overlapChars } = options;
  if (!Number.isSafeInteger(chunkChars) || chunkChars < 16) {
    throw new RangeError("chunkChars must be at least 16");
  }
  if (!Number.isSafeInteger(overlapChars) || overlapChars < 0 || overlapChars >= chunkChars / 2) {
    throw new RangeError("overlapChars must be below half of chunkChars");
  }
  if (text.length <= chunkChars) return [{ start: 0, text }];
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + chunkChars);
    if (end < text.length) {
      // Prefer the last whitespace in the final quarter of the window.
      const floor = start + Math.floor(chunkChars * 0.75);
      let cut = end;
      while (cut > floor && !whitespace.test(text.charAt(cut - 1))) cut -= 1;
      end = cut > floor ? cut : end;
      if (isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
    }
    chunks.push({ start, text: text.slice(start, end) });
    if (end >= text.length) break;
    // The next chunk starts at a word start inside the overlap window.
    let next = Math.max(start + 1, end - overlapChars);
    while (next < end && !whitespace.test(text.charAt(next - 1))) next += 1;
    start = next;
  }
  return chunks;
}
