"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccessApi } from "../api.ts";
import { afterSignInPath, navigateAcrossGroups, SIGN_IN_PATH, VERIFY_PATH } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { formatDateTime } from "../ui/format.ts";
import { Notice } from "../ui/notice.tsx";
import { OtpInput, type OtpInputHandle } from "../ui/otp-input.tsx";
import { describeSendFailure, describeVerifyFailure, type OtpMessage } from "../ui/otp-messages.ts";
import { formatCountdown, useCountdown } from "../ui/use-countdown.ts";
import { useQueryParam } from "../ui/use-query-param.ts";
import { challengeFrom, useSignInFlow } from "./flow.tsx";

/**
 * Email verification (email_otp.md), shared by sign-in and new-account verification: one code field
 * that accepts paste and one-time-code autofill, a resend with a visible cooldown, and calm wording
 * for every refusal. Verifying an email never admits the account to the beta (note 03).
 */
export function VerifyCode() {
  const api = useAccessApi();
  const router = useRouter();
  const flow = useSignInFlow();
  const controls = useSessionControls();
  const next = useQueryParam("next");
  const challenge = flow.challenge;
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  /** `field` messages belong to the code input; send failures are their own notice. */
  const [message, setMessage] = useState<(OtpMessage & { readonly field?: boolean }) | null>(null);
  const inputRef = useRef<OtpInputHandle>(null);
  const submitted = useRef<string | null>(null);

  // Only once session storage has been read: a reload restores the challenge there, and this effect
  // runs before the provider's own hydration effect.
  useEffect(() => {
    if (flow.hydrated && !challenge) router.replace(SIGN_IN_PATH);
  }, [flow.hydrated, challenge, router]);

  const cooldown = useCountdown(challenge?.resendAvailableAt ?? null);
  const blocked = useCountdown(message?.blockedUntil ?? null);

  if (!challenge) {
    return (
      <EntryFrame>
        <p role="status" className="text-[13.5px] text-sym-muted">
          Opening email entry…
        </p>
      </EntryFrame>
    );
  }

  const busy = verifying || resending;
  const locked = blocked > 0;
  const complete = code.length === challenge.codeLength;
  const needsNewCode = message?.needsNewCode === true;

  const verify = async (value: string) => {
    if (busy || locked) return;
    if (value.length !== challenge.codeLength) {
      setMessage({
        tone: "warning",
        text: `Enter all ${challenge.codeLength} digits from the email.`,
      });
      return;
    }
    submitted.current = value;
    setVerifying(true);
    setMessage(null);
    try {
      const me = await api.verifyCode(challenge.challengeId, value);
      controls.setMe(me);
      flow.clear();
      navigateAcrossGroups(router, afterSignInPath(me, next), {
        replace: true,
        from: VERIFY_PATH,
      });
    } catch (error) {
      setCode("");
      setMessage({ ...describeVerifyFailure(error), field: true });
      inputRef.current?.focus();
    } finally {
      setVerifying(false);
    }
  };

  const resend = async () => {
    if (busy || locked || (cooldown > 0 && !needsNewCode)) return;
    setResending(true);
    setMessage(null);
    try {
      const response =
        challenge.purpose === "signup"
          ? await api.signup(challenge.email)
          : await api.sendLoginCode(challenge.email);
      flow.setChallenge(challengeFrom(challenge.email, response));
      setCode("");
      submitted.current = null;
      setMessage({
        tone: "success",
        text: `We sent a new code to ${challenge.email}. Enter the newest one.`,
      });
      inputRef.current?.focus();
    } catch (error) {
      setMessage(describeSendFailure(error));
    } finally {
      setResending(false);
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void verify(code);
  };

  const resendLabel = resending
    ? "Sending…"
    : cooldown > 0 && !needsNewCode
      ? `Send a new code in ${formatCountdown(cooldown)}`
      : "Send a new code";
  const inlineError =
    message?.field && message.tone === "error" && !message.needsNewCode ? message.text : null;

  return (
    <EntryFrame>
      <div className="flex flex-col gap-2">
        <ScreenHeading>Check your email</ScreenHeading>
        <Lede>
          {challenge.purpose === "signup"
            ? "Enter the code we sent to verify your email. Verifying confirms who you are; opening the app still needs an invite."
            : "Enter the code we sent to sign in."}
        </Lede>
        <p className="m-0 flex flex-wrap items-center gap-2 text-[13.5px]">
          <span className="font-medium text-sym-text">{challenge.email}</span>
          <Button
            variant="link"
            size="sm"
            onClick={() => {
              flow.setChallenge(null);
              router.push(SIGN_IN_PATH);
            }}
          >
            Edit email
          </Button>
        </p>
      </div>
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <OtpInput
          ref={inputRef}
          length={challenge.codeLength}
          value={code}
          onChange={setCode}
          onComplete={(value) => {
            if (value !== submitted.current) void verify(value);
          }}
          label={`${challenge.codeLength}-digit code`}
          description={`The code expires at ${formatDateTime(challenge.expiresAt)}. Paste or autofill works.`}
          disabled={busy || locked}
          autoFocus
          name="one-time-code"
          {...(inlineError ? { error: inlineError } : {})}
        />
        {message && !inlineError ? (
          <Notice tone={message.tone} {...(message.title ? { title: message.title } : {})}>
            {message.blockedUntil && locked
              ? `${message.text} (${formatCountdown(blocked)})`
              : message.text}
          </Notice>
        ) : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={busy || locked || !complete}
          aria-busy={verifying || undefined}
        >
          {verifying ? <Spinner size={12} /> : null}
          {verifying ? "Verifying…" : "Verify"}
        </Button>
      </form>
      <div className="flex flex-col gap-1.5">
        <Button
          variant="secondary"
          size="lg"
          className="w-full"
          disabled={busy || locked || (cooldown > 0 && !needsNewCode)}
          aria-busy={resending || undefined}
          onClick={() => {
            void resend();
          }}
        >
          {resending ? <Spinner size={12} /> : null}
          {resendLabel}
        </Button>
        <p className="m-0 text-center text-[12.5px] text-sym-muted">
          A new code replaces the previous one. Codes are only for signing in — they never unlock
          beta access.
        </p>
      </div>
    </EntryFrame>
  );
}
