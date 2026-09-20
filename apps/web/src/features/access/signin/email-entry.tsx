"use client";

import { isNormalizableEmail, normalizeEmail } from "@symplist/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccessApi } from "../api.ts";
import { type AccessProblem, describeWait, problemOf } from "../errors.ts";
import { afterSignInPath, CREATE_ACCOUNT_PATH, VERIFY_PATH } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { TextField } from "../ui/field.tsx";
import { Notice } from "../ui/notice.tsx";
import { formatCountdown, useCountdown } from "../ui/use-countdown.ts";
import { useQueryParam } from "../ui/use-query-param.ts";
import { challengeFrom, useSignInFlow } from "./flow.tsx";

type Stage = "idle" | "checking" | "sending";

interface Failure {
  readonly tone: "error" | "warning";
  readonly title?: string;
  readonly message: string;
  /** Epoch milliseconds before which Continue stays disabled. */
  readonly retryAt?: number;
  /** Offers account creation for this address (the account disappeared between two steps). */
  readonly offerSignup?: boolean;
}

function failureFor(problem: AccessProblem): Failure {
  switch (problem.kind) {
    case "network":
      return {
        tone: "error",
        message: "Symplist couldn't be reached. Check your connection and try again.",
      };
    case "throttled":
      return {
        tone: "warning",
        title: "Too many tries",
        message:
          problem.retryAfterSeconds === null
            ? "Wait a moment before asking for another code."
            : `Wait ${describeWait(problem.retryAfterSeconds)} before asking for another code.`,
        ...(problem.retryAfterSeconds === null
          ? {}
          : { retryAt: Date.now() + problem.retryAfterSeconds * 1000 }),
      };
    case "session_expired":
      return { tone: "error", message: "Something went wrong. Try again." };
    case "api":
      switch (problem.code) {
        case "auth.account_not_found":
          return {
            tone: "warning",
            message: "There's no account for this address any more.",
            offerSignup: true,
          };
        case "auth.account_unavailable":
          return {
            tone: "warning",
            title: "This account is being deleted",
            message:
              "Sign-in is closed for this address while the deletion finishes. You can register again afterwards.",
          };
        case "auth.delivery_failed":
          return {
            tone: "error",
            title: "We couldn't send the code",
            message: "Nothing was sent. Try again.",
          };
        default:
          return { tone: "error", message: "Something went wrong. Try again." };
      }
    case "aborted":
    case "unexpected":
      return { tone: "error", message: "Something went wrong on our side. Try again." };
  }
}

/**
 * Email entry (email_entry.md): the first screen, kept as an application entry with one field and
 * Continue. A known address gets a sign-in code and moves to verification; an unknown one moves to an
 * explicit signup confirmation. Nothing here promises a code was sent before the api accepted it.
 */
export function EmailEntry() {
  const api = useAccessApi();
  const router = useRouter();
  const flow = useSignInFlow();
  const controls = useSessionControls();
  const expired = useQueryParam("expired") === "1";
  const deleted = useQueryParam("deleted") === "1";
  const next = useQueryParam("next");
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<Stage>("idle");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);

  // Coming back from signup confirmation or verification keeps the address editable.
  useEffect(() => {
    if (restored.current || !flow.email) return;
    restored.current = true;
    setEmail(flow.email);
  }, [flow.email]);

  const signedIn = controls.snapshot.phase === "signed_in" && controls.me !== null;
  useEffect(() => {
    if (!signedIn || !controls.me) return;
    router.replace(afterSignInPath(controls.me, next));
  }, [signedIn, controls.me, next, router]);

  const waitSeconds = useCountdown(failure?.retryAt ?? null);
  const waiting = waitSeconds > 0;
  const busy = stage !== "idle";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || waiting) return;
    const address = email.trim();
    if (!isNormalizableEmail(address)) {
      setInvalid("Enter an email address, for example maya@example.com");
      setFailure(null);
      inputRef.current?.focus();
      return;
    }
    const normalized = normalizeEmail(address);
    setInvalid(null);
    setFailure(null);
    setStage("checking");
    try {
      const { exists } = await api.lookup(normalized);
      flow.setEmail(normalized);
      if (!exists) {
        setStage("idle");
        router.push(CREATE_ACCOUNT_PATH);
        return;
      }
      setStage("sending");
      const challenge = await api.sendLoginCode(normalized);
      flow.setChallenge(challengeFrom(normalized, challenge));
      setStage("idle");
      router.push(VERIFY_PATH);
    } catch (error) {
      setStage("idle");
      setFailure(failureFor(problemOf(error)));
    }
  };

  if (signedIn) {
    return (
      <EntryFrame>
        <p role="status" className="text-[13.5px] text-sym-muted">
          You're already signed in. Opening your account…
        </p>
      </EntryFrame>
    );
  }

  return (
    <EntryFrame motif>
      <div className="flex flex-col gap-2">
        <ScreenHeading>Sign in to Symplist</ScreenHeading>
        <Lede>
          A calm place for your tasks, their pages and one conversation each. Enter your email and
          we'll send a sign-in code.
        </Lede>
      </div>
      {expired ? (
        <Notice tone="info" live="none">
          Your session has ended. Sign in again to pick up where you left off.
        </Notice>
      ) : null}
      {deleted ? (
        <Notice tone="info" live="none" title="Your account has been deleted">
          Its contents can no longer be read by anyone, and the stored copies are being erased. You
          can register again with this address whenever you like.
        </Notice>
      ) : null}
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          ref={inputRef}
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          enterKeyHint="go"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="maya@example.com"
          value={email}
          disabled={busy}
          error={invalid}
          onChange={(event) => {
            setEmail(event.target.value);
            if (invalid) setInvalid(null);
          }}
        />
        {failure ? (
          <Notice
            tone={failure.tone}
            {...(failure.title ? { title: failure.title } : {})}
            actions={
              failure.offerSignup ? (
                <Button
                  size="sm"
                  onClick={() => {
                    flow.setEmail(normalizeEmail(email.trim()));
                    router.push(CREATE_ACCOUNT_PATH);
                  }}
                >
                  Create an account
                </Button>
              ) : null
            }
          >
            {waiting && failure.retryAt
              ? `${failure.message} (${formatCountdown(waitSeconds)})`
              : failure.message}
          </Notice>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={busy || waiting}
          aria-busy={busy || undefined}
        >
          {busy ? <Spinner size={12} /> : null}
          {stage === "sending" ? "Sending code…" : stage === "checking" ? "Checking…" : "Continue"}
        </Button>
      </form>
      <Notice tone="info" live="none">
        <span className="font-medium">Closed beta.</span> Anyone can register, but opening the app
        needs an invite code that Symplist's owner shares personally.
      </Notice>
    </EntryFrame>
  );
}
