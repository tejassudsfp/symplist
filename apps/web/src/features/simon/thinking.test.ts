import { describe, expect, it } from "vitest";
import {
  phrasesFor,
  QUEUED_PHRASES,
  THINKING_ROTATION_MS,
  thinkingPhrase,
  WORKING_PHRASES,
} from "./thinking.ts";

describe("thinking phrases", () => {
  it("opens each phase on its most informative line", () => {
    expect(thinkingPhrase("queued", 0)).toBe(QUEUED_PHRASES[0]);
    expect(thinkingPhrase("working", 0)).toBe(WORKING_PHRASES[0]);
  });

  it("advances one phrase per tick and wraps without a gap", () => {
    const seen = WORKING_PHRASES.map((_, tick) => thinkingPhrase("working", tick));
    expect(seen).toEqual([...WORKING_PHRASES]);
    expect(thinkingPhrase("working", WORKING_PHRASES.length)).toBe(WORKING_PHRASES[0]);
  });

  it("is deterministic, so a re-render never reshuffles the line being read", () => {
    expect(thinkingPhrase("working", 3)).toBe(thinkingPhrase("working", 3));
  });

  it("keeps the two phases separate", () => {
    expect(phrasesFor("queued")).toEqual(QUEUED_PHRASES);
    expect(phrasesFor("working")).toEqual(WORKING_PHRASES);
    expect(QUEUED_PHRASES.some((phrase) => WORKING_PHRASES.includes(phrase))).toBe(false);
  });

  it("survives a negative or fractional tick rather than rendering undefined", () => {
    expect(WORKING_PHRASES).toContain(thinkingPhrase("working", -1));
    expect(WORKING_PHRASES).toContain(thinkingPhrase("working", 2.7));
  });

  it("holds a phrase long enough to read", () => {
    expect(THINKING_ROTATION_MS).toBeGreaterThanOrEqual(2_000);
  });

  it("never promises more than a facilitator does", () => {
    for (const phrase of [...QUEUED_PHRASES, ...WORKING_PHRASES]) {
      expect(phrase.length).toBeLessThanOrEqual(56);
      expect(phrase).not.toMatch(/\b(researching|coding|building your)\b/iu);
    }
  });
});
