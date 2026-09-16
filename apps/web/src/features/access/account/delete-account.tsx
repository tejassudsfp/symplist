"use client";

import type { MeResponse } from "@symplist/contracts";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { IdempotencyKeys } from "@/lib/api";
import { clearSharedCsrfToken, useAccessApi } from "../api.ts";
import { problemOf } from "../errors.ts";
import { beginAccountDeletionExit, clearBrowserSessionState } from "../sign-out.ts";
import { formatDateTime } from "../ui/format.ts";
import { Notice } from "../ui/notice.tsx";
import { OtpInput, type OtpInputHandle } from "../ui/otp-input.tsx";
import { describeSendFailure, describeVerifyFailure, type OtpMessage } from "../ui/otp-messages.ts";

type Step =
  | { readonly kind: "idle" }
  | { readonly kind: "code"; readonly challengeId: string; readonly codeLength: number }
  | { readonly kind: "authorized"; readonly authorizationId: string; readonly expiresAt: number }
  | { readonly kind: "deleting" };

/** Where the person continues after the account is gone. */
export const DELETED_SIGN_IN_PATH = "/signin?deleted=1";

export interface DeleteAccountProps {
  readonly me: MeResponse;
  /** Overridable for tests; defaults to a full document navigation. */
  readonly onDeleted?: () => void;
}

/**
 * Account deletion (settings_account.md, §5.6): a confirmation that says plainly what is destroyed,
 * then a fresh emailed code before anything happens, then the request itself. The account key is
 * destroyed as soon as the api accepts, and the rest is erased in the background; nothing here claims
 * the erasure has finished or promises a retention period.
 */
export function DeleteAccount({ me, onDeleted }: DeleteAccountProps) {
  const api = useAccessApi();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [message, setMessage] = useState<OtpMessage | null>(null);
  const codeRef = useRef<OtpInputHandle>(null);
  const keys = useRef(new IdempotencyKeys());

  const startVerification = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const challenge = await api.sendDeletionCode();
      setStep({
        kind: "code",
        challengeId: challenge.challengeId,
        codeLength: challenge.codeLength,
      });
      setCode("");
      setMessage({
        tone: "success",
        text: `We sent a confirmation code to ${me.user.email}. It only confirms this deletion.`,
      });
    } catch (error) {
      setMessage(describeSendFailure(error));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (value: string) => {
    if (step.kind !== "code" || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const authorization = await api.verifyDeletionCode(step.challengeId, value);
      setStep({
        kind: "authorized",
        authorizationId: authorization.authorizationId,
        expiresAt: authorization.expiresAt,
      });
      setCode("");
    } catch (error) {
      const next = describeVerifyFailure(error);
      setMessage(next);
      setCode("");
      if (next.needsNewCode) setStep({ kind: "idle" });
      else codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (step.kind !== "authorized" || busy) return;
    setBusy(true);
    setMessage(null);
    const previous = step;
    setStep({ kind: "deleting" });
    try {
      await api.requestDeletion(previous.authorizationId, keys.current.acquire("delete-account"));
      keys.current.release("delete-account");
      await clearBrowserSessionState({ clearCsrfToken: clearSharedCsrfToken });
      // Gates stop redirecting while this is set, so only this navigation runs.
      beginAccountDeletionExit();
      if (onDeleted) onDeleted();
      else window.location.assign(DELETED_SIGN_IN_PATH);
    } catch (error) {
      const problem = problemOf(error);
      setStep(previous);
      if (problem.kind === "api" && problem.code === "account.deletion_unauthorized") {
        keys.current.release("delete-account");
        setStep({ kind: "idle" });
        setMessage({
          tone: "warning",
          title: "That confirmation has expired",
          text: "Nothing was deleted. Start again to get a new code.",
        });
      } else if (problem.kind === "network") {
        setMessage({
          tone: "error",
          text: "Symplist couldn't be reached, so nothing was deleted. Try again.",
        });
      } else if (problem.kind === "session_expired") {
        setMessage({
          tone: "warning",
          text: "Your session has ended. Sign in again to delete the account.",
        });
      } else {
        setMessage({
          tone: "error",
          text: "Something went wrong on our side. Nothing was deleted.",
        });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="delete-account-title"
      data-slot="danger-zone"
      className="flex flex-col gap-3 rounded-sym-lg border border-sym-line-strong p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="delete-account-title" className="m-0 font-heading font-semibold text-[15px]">
          Delete this account
        </h2>
        <p className="m-0 text-[13.5px] text-sym-muted [text-wrap:pretty]">
          Deleting destroys the key to your data: tasks, their pages and history, conversations,
          vault items and saved files can no longer be read by anyone, including us. Connected
          services are disconnected and their access revoked. It cannot be undone, and email already
          sent can't be recalled.
        </p>
      </div>

      {message ? (
        <Notice tone={message.tone} {...(message.title ? { title: message.title } : {})}>
          {message.text}
        </Notice>
      ) : null}

      {step.kind === "idle" ? (
        <div>
          <Button
            variant="danger"
            size="lg"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => setConfirmOpen(true)}
          >
            {busy ? <Spinner size={12} /> : null}
            {busy ? "Sending code…" : "Delete account"}
          </Button>
        </div>
      ) : null}

      {step.kind === "code" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void verify(code);
          }}
          noValidate
        >
          <OtpInput
            ref={codeRef}
            length={step.codeLength}
            value={code}
            onChange={setCode}
            onComplete={(value) => {
              void verify(value);
            }}
            label="Confirmation code"
            description="Enter the code we just emailed. It confirms this deletion only."
            disabled={busy}
            autoFocus
            name="one-time-code"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant="danger"
              size="lg"
              disabled={busy || code.length !== step.codeLength}
              aria-busy={busy || undefined}
            >
              {busy ? <Spinner size={12} /> : null}
              {busy ? "Checking…" : "Confirm code"}
            </Button>
            <Button
              variant="ghost"
              size="lg"
              disabled={busy}
              onClick={() => {
                setStep({ kind: "idle" });
                setCode("");
                setMessage(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {step.kind === "authorized" ? (
        <div className="flex flex-col gap-3">
          <Notice tone="warning" title="Ready to delete" live="none">
            This confirmation is valid until {formatDateTime(step.expiresAt)}. Deleting starts at
            once and cannot be stopped.
          </Notice>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="danger"
              size="lg"
              disabled={busy}
              aria-busy={busy || undefined}
              onClick={() => {
                void remove();
              }}
            >
              Delete my account permanently
            </Button>
            <Button
              variant="ghost"
              size="lg"
              disabled={busy}
              onClick={() => {
                setStep({ kind: "idle" });
                setMessage(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {step.kind === "deleting" ? (
        <p role="status" className="m-0 flex items-center gap-2 text-[13.5px] text-sym-muted">
          <Spinner size={12} />
          Deleting your account…
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Delete your Symplist account?"
        description={
          <>
            Your tasks, pages, document history, conversations, vault items and files become
            unreadable immediately, and the stored copies are erased in the background. Connected
            services are disconnected. This cannot be undone.
            <br />
            <br />
            To be sure it's you, we'll email a confirmation code before anything is deleted.
          </>
        }
        confirmLabel="Send confirmation code"
        cancelLabel="Keep my account"
        initialFocus="cancel"
        busy={busy}
        onConfirm={() => {
          setConfirmOpen(false);
          void startVerification();
        }}
      />
    </section>
  );
}
