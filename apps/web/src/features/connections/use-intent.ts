"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, createIdempotencyKey } from "@/lib/api";
import { connectionError } from "./resource.ts";

/** One frozen intent survives a lost response. Retry never changes its input or idempotency key. */
export function useIntent<Input, Output>(
  execute: (input: Input, key: string, signal: AbortSignal) => Promise<Output>,
  applied: (output: Output) => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ input: Input; key: string } | null>(null);
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const epoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    setBusy(false);
    return () => {
      mounted.current = false;
      epoch.current++;
      active.current?.abort();
      active.current = null;
    };
  }, []);
  const run = async (input?: Input) => {
    if (active.current || !mounted.current) return;
    if (!pending.current && input !== undefined)
      pending.current = { input, key: createIdempotencyKey() };
    const intent = pending.current;
    if (!intent) return;
    const controller = new AbortController();
    const ticket = epoch.current;
    active.current = controller;
    setBusy(true);
    setError(null);
    try {
      const output = await execute(intent.input, intent.key, controller.signal);
      if (!mounted.current || ticket !== epoch.current) return;
      applied(output);
      pending.current = null;
    } catch (error) {
      if (mounted.current && ticket === epoch.current) {
        // These responses prove the request was refused. Editing may start a new intent; timeouts,
        // throttling and in-progress/uncertain outcomes must keep the original fingerprint.
        if (error instanceof ApiError && [400, 401, 403, 404, 410, 422].includes(error.status))
          pending.current = null;
        setError(connectionError(error));
      }
    } finally {
      if (mounted.current && ticket === epoch.current) {
        active.current = null;
        setBusy(false);
      }
    }
  };
  return {
    busy,
    error,
    uncertain: pending.current !== null && error !== null,
    run,
    reset: () => {
      if (!active.current) {
        pending.current = null;
        setError(null);
      }
    },
  };
}
