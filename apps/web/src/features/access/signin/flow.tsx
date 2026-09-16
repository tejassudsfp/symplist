"use client";

import type { OtpChallengeResponse, OtpPurpose } from "@symplist/contracts";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/** The code challenge a sign-in or signup send returned, with the address it was sent to. */
export interface SignInChallenge {
  readonly email: string;
  readonly challengeId: string;
  readonly purpose: Extract<OtpPurpose, "login" | "signup">;
  readonly expiresAt: number;
  readonly resendAvailableAt: number;
  readonly codeLength: number;
}

export interface SignInFlow {
  /** The address being signed in with, kept while moving between the three steps. */
  readonly email: string;
  setEmail(email: string): void;
  readonly challenge: SignInChallenge | null;
  setChallenge(challenge: SignInChallenge | null): void;
  /** Forgets the flow after a successful verification or a deliberate restart. */
  clear(): void;
}

interface StoredFlow {
  readonly email: string;
  readonly challenge: SignInChallenge | null;
}

/** Session storage only: the address and challenge id survive a reload, the code never exists here. */
export const SIGN_IN_FLOW_KEY = "symplist.access.signin";

const SignInFlowContext = createContext<SignInFlow | null>(null);

function readStored(): StoredFlow {
  if (typeof window === "undefined") return { email: "", challenge: null };
  try {
    const raw = window.sessionStorage.getItem(SIGN_IN_FLOW_KEY);
    if (!raw) return { email: "", challenge: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return { email: "", challenge: null };
    const value = parsed as Partial<StoredFlow>;
    const email = typeof value.email === "string" ? value.email : "";
    const challenge = value.challenge ?? null;
    if (
      challenge &&
      typeof challenge.challengeId === "string" &&
      typeof challenge.email === "string" &&
      (challenge.purpose === "login" || challenge.purpose === "signup") &&
      typeof challenge.expiresAt === "number" &&
      typeof challenge.resendAvailableAt === "number" &&
      typeof challenge.codeLength === "number"
    ) {
      return { email, challenge };
    }
    return { email, challenge: null };
  } catch {
    return { email: "", challenge: null };
  }
}

function writeStored(flow: StoredFlow): void {
  try {
    window.sessionStorage.setItem(SIGN_IN_FLOW_KEY, JSON.stringify(flow));
  } catch {
    // Without session storage the flow still works within one page's lifetime.
  }
}

/**
 * Keeps the sign-in flow across its three steps (email entry, signup confirmation, verification). It
 * lives in the `(auth)` layout, so moving between the steps never loses the address, and a reload
 * restores it from session storage. Codes are never stored.
 */
export function SignInFlowProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StoredFlow>({ email: "", challenge: null });
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(readStored());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) writeStored(state);
  }, [state, hydrated]);

  const setEmail = useCallback((email: string) => {
    setState((current) => ({ ...current, email }));
  }, []);

  const setChallenge = useCallback((challenge: SignInChallenge | null) => {
    setState((current) => ({ email: challenge?.email ?? current.email, challenge }));
  }, []);

  const clear = useCallback(() => {
    setState({ email: "", challenge: null });
    try {
      window.sessionStorage.removeItem(SIGN_IN_FLOW_KEY);
    } catch {
      // Nothing to remove.
    }
  }, []);

  const value = useMemo<SignInFlow>(
    () => ({ email: state.email, setEmail, challenge: state.challenge, setChallenge, clear }),
    [state, setEmail, setChallenge, clear],
  );

  return <SignInFlowContext.Provider value={value}>{children}</SignInFlowContext.Provider>;
}

export function useSignInFlow(): SignInFlow {
  const flow = useContext(SignInFlowContext);
  if (!flow) throw new Error("useSignInFlow must be used inside SignInFlowProvider");
  return flow;
}

/** The challenge a send response describes, bound to the address it was sent to. */
export function challengeFrom(email: string, response: OtpChallengeResponse): SignInChallenge {
  return {
    email,
    challengeId: response.challengeId,
    purpose: response.purpose === "signup" ? "signup" : "login",
    expiresAt: response.expiresAt,
    resendAvailableAt: response.resendAvailableAt,
    codeLength: response.codeLength,
  };
}
