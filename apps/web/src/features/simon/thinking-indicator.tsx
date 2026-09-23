"use client";

import { useEffect, useState } from "react";
import { THINKING_ROTATION_MS, type ThinkingPhase, thinkingPhrase } from "./thinking.ts";

/**
 * The live-run status line: three pulsing dots and a phrase that changes while the turn runs, so a
 * slow start reads as work in progress rather than as a stalled screen.
 *
 * The caller keys this on the phase, so a change of phase remounts it and the rotation restarts at
 * that phase's first and most informative line rather than inheriting a tick from the previous one.
 *
 * `aria-live` is deliberately absent. The rotation would otherwise announce a new line every few
 * seconds to a screen reader for as long as the turn lasts, which is noise, not information. The
 * element keeps `role="status"` so the phase is available on demand, and the phrase carries no
 * meaning the reader loses by not hearing every variant.
 *
 * Reduced motion is honoured by the stylesheet, which stops the dot animation; the phrase still
 * rotates because it is text, not motion.
 */
export function ThinkingIndicator({ phase }: { phase: ThinkingPhase }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), THINKING_ROTATION_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <p role="status" className="sym-simon-thinking" data-phase={phase} data-slot="thinking">
      <span className="sym-simon-thinking-dots" aria-hidden="true">
        <span className="sym-simon-thinking-dot" />
        <span className="sym-simon-thinking-dot" />
        <span className="sym-simon-thinking-dot" />
      </span>
      <span className="sym-simon-thinking-text">{thinkingPhrase(phase, tick)}</span>
    </p>
  );
}
