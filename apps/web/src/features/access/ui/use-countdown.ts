"use client";

import { useEffect, useState } from "react";

/**
 * Whole seconds until `target` (epoch milliseconds), ticking every second and stopping at zero. A null
 * target is already due.
 */
export function useCountdown(target: number | null, now: () => number = Date.now): number {
  const remaining = () => (target === null ? 0 : Math.max(0, Math.ceil((target - now()) / 1000)));
  const [seconds, setSeconds] = useState(remaining);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the clock function is stable per caller; only the target restarts the timer.
  useEffect(() => {
    setSeconds(remaining());
    if (target === null) return;
    const timer = setInterval(() => {
      const next = remaining();
      setSeconds(next);
      if (next === 0) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [target]);
  return seconds;
}

/** `0:42` for a countdown. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
