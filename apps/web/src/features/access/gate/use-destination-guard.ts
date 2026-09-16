"use client";

import type { AccessDestination, MeResponse } from "@symplist/contracts";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { destinationPath, navigateAcrossGroups } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";

export interface DestinationGuard {
  readonly me: MeResponse | null;
  /** True while the account belongs on this screen. */
  readonly allowed: boolean;
}

/**
 * Keeps each gate and onboarding screen showing only the state it is for: an account whose
 * destination moved (unlocked by an administrator, relocked, onboarding finished) is sent to the
 * screen that matches, so no screen ever contradicts the api's answer (§5.4).
 */
export function useDestinationGuard(allowed: readonly AccessDestination[]): DestinationGuard {
  const { me } = useSessionControls();
  const router = useRouter();
  const destination = me?.destination ?? null;
  const ok = destination !== null && allowed.includes(destination);
  useEffect(() => {
    if (!me || ok) return;
    navigateAcrossGroups(router, destinationPath(me), { replace: true });
  }, [me, ok, router]);
  return { me, allowed: ok };
}
