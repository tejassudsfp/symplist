/**
 * What the chat says while a run is live.
 *
 * The old copy was one fixed line per status ("Message accepted · waiting to start"), which reads as
 * a receipt rather than as work happening, and never changes however long the turn takes. A run can
 * sit for several seconds before its first token — a durable turn pays a dispatch and, outside the
 * session idle window, a cold boot — so a still line is exactly when the product feels broken.
 *
 * The phrases are data here rather than strings inside the component so their tone is reviewable in
 * one place and the rotation is testable without rendering a chat. They are deliberately about the
 * work rather than about the model: Simon is a facilitator, and copy that boasts about thinking
 * invites the comparison with general-purpose assistants that note 16 tells us not to make.
 */

/** A status the chat shows while the run has not produced its reply yet. */
export type ThinkingPhase = "queued" | "working";

/**
 * Lines shown while the turn has been accepted but has not started. These acknowledge the wait
 * honestly: the run is real and recorded, it simply has not begun.
 */
export const QUEUED_PHRASES: readonly string[] = Object.freeze([
  "Getting your place in the queue…",
  "Lining this one up…",
  "Waiting for the current work to finish…",
  "Your message is safe — just waiting its turn…",
]);

/**
 * Lines shown while Simon is actually working the turn. Short, concrete, and quietly on-brand: the
 * founding idea is that the most productive thing is often the most simple.
 */
export const WORKING_PHRASES: readonly string[] = Object.freeze([
  "Simon is thinking…",
  "Reading the room…",
  "Looking for the simplest version of this…",
  "Checking what's actually connected…",
  "Working out what you really need…",
  "Turning this into something you can act on…",
  "Doing the boring part so you don't have to…",
  "One clear next step, coming up…",
  "Making this smaller, not bigger…",
  "Finding the shortest path…",
]);

/** How long each phrase holds before the next one replaces it. */
export const THINKING_ROTATION_MS = 2_600;

export function phrasesFor(phase: ThinkingPhase): readonly string[] {
  return phase === "queued" ? QUEUED_PHRASES : WORKING_PHRASES;
}

/**
 * The phrase for a phase at a given tick.
 *
 * Deterministic on the tick rather than random, so a re-render never reshuffles the line under the
 * reader and a test can assert the sequence. The first tick of a phase is always its first phrase,
 * which keeps the most informative line the one people actually read.
 */
export function thinkingPhrase(phase: ThinkingPhase, tick: number): string {
  const phrases = phrasesFor(phase);
  const index = ((Math.trunc(tick) % phrases.length) + phrases.length) % phrases.length;
  return phrases[index] as string;
}
