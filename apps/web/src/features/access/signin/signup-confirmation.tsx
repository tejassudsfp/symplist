"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccessApi } from "../api.ts";
import { describeWait, problemOf } from "../errors.ts";
import { SIGN_IN_PATH, VERIFY_PATH } from "../navigation.ts";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { Notice } from "../ui/notice.tsx";
import { challengeFrom, useSignInFlow } from "./flow.tsx";

type Failure =
  | { readonly kind: "delivery" }
  | { readonly kind: "exists" }
  | { readonly kind: "network" }
  | { readonly kind: "throttled"; readonly message: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unexpected" };

/**
 * Permission to create an account (signup_confirmation.md): a compact continuation of email entry
 * where only an explicit Create account makes the pending account and sends the verification code.
 * Nothing here sends or promises an invite.
 */
export function SignupConfirmation() {
  const api = useAccessApi();
  const router = useRouter();
  const flow = useSignInFlow();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempted = useRef(false);
  const email = flow.email;

  // Only once session storage has been read: a reload restores the address there, and this effect
  // runs before the provider's own hydration effect.
  useEffect(() => {
    if (flow.hydrated && !email) router.replace(SIGN_IN_PATH);
  }, [flow.hydrated, email, router]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        router.push(SIGN_IN_PATH);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, router]);

  if (!email) {
    return (
      <EntryFrame>
        <p role="status" className="text-[13.5px] text-sym-muted">
          Opening email entry…
        </p>
      </EntryFrame>
    );
  }

  const createAccount = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const challenge = await api.signup(email);
      attempted.current = true;
      flow.setChallenge(challengeFrom(email, challenge));
      router.push(VERIFY_PATH);
    } catch (error) {
      attempted.current = true;
      const problem = problemOf(error);
      if (problem.kind === "network") setFailure({ kind: "network" });
      else if (problem.kind === "throttled") {
        setFailure({
          kind: "throttled",
          message:
            problem.retryAfterSeconds === null
              ? "Wait a moment before trying again."
              : `Wait ${describeWait(problem.retryAfterSeconds)} before trying again.`,
        });
      } else if (problem.kind === "api" && problem.code === "auth.account_exists") {
        setFailure({ kind: "exists" });
      } else if (problem.kind === "api" && problem.code === "auth.account_unavailable") {
        setFailure({ kind: "unavailable" });
      } else if (problem.kind === "api" && problem.code === "auth.delivery_failed") {
        setFailure({ kind: "delivery" });
      } else setFailure({ kind: "unexpected" });
    } finally {
      setBusy(false);
    }
  };

  const sendSignInCode = async () => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const challenge = await api.sendLoginCode(email);
      flow.setChallenge(challengeFrom(email, challenge));
      router.push(VERIFY_PATH);
    } catch (error) {
      const problem = problemOf(error);
      setFailure(
        problem.kind === "network"
          ? { kind: "network" }
          : problem.kind === "throttled"
            ? {
                kind: "throttled",
                message:
                  problem.retryAfterSeconds === null
                    ? "Wait a moment before trying again."
                    : `Wait ${describeWait(problem.retryAfterSeconds)} before trying again.`,
              }
            : { kind: "unexpected" },
      );
    } finally {
      setBusy(false);
    }
  };

  const raced = failure?.kind === "exists";
  const primaryLabel = raced
    ? busy
      ? "Sending code…"
      : "Send a sign-in code"
    : busy
      ? "Creating account…"
      : attempted.current
        ? "Send the code again"
        : "Create account";

  return (
    <EntryFrame>
      <div className="flex flex-col gap-2">
        <ScreenHeading>No account found</ScreenHeading>
        <Lede>
          <span className="font-medium text-sym-text">{email}</span> isn't registered yet. Create an
          account with this email?
        </Lede>
      </div>
      {failure ? (
        <Notice
          tone={failure.kind === "throttled" ? "warning" : "error"}
          title={
            failure.kind === "delivery"
              ? "We couldn't send the code"
              : failure.kind === "exists"
                ? "This email already has an account"
                : failure.kind === "unavailable"
                  ? "This account is being deleted"
                  : failure.kind === "throttled"
                    ? "Too many tries"
                    : undefined
          }
        >
          {failure.kind === "delivery"
            ? "Your account is waiting for verification, and nothing was sent. Try again."
            : failure.kind === "exists"
              ? "Continue with a sign-in code instead — nothing was created twice."
              : failure.kind === "unavailable"
                ? "This address can't be registered again while its deletion finishes."
                : failure.kind === "network"
                  ? "Symplist couldn't be reached. Check your connection and try again."
                  : failure.kind === "throttled"
                    ? failure.message
                    : "Something went wrong on our side. Try again."}
        </Notice>
      ) : null}
      <div className="flex flex-col gap-2.5">
        <Button
          variant="primary"
          size="lg"
          className="w-full"
          disabled={busy || failure?.kind === "unavailable"}
          aria-busy={busy || undefined}
          onClick={() => {
            void (raced ? sendSignInCode() : createAccount());
          }}
        >
          {busy ? <Spinner size={12} /> : null}
          {primaryLabel}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          disabled={busy}
          onClick={() => router.push(SIGN_IN_PATH)}
        >
          Use another email
        </Button>
      </div>
      <p className="m-0 text-[12.5px] text-sym-muted [text-wrap:pretty]">
        Creating an account verifies your email. Opening the app still needs an invite code that
        Symplist's owner shares personally — signing up never sends one.
      </p>
    </EntryFrame>
  );
}
