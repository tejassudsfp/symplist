"use client";

import {
  type AdminInvite,
  formatInviteHint,
  type GenerateInvitesRequest,
  type GenerateInvitesResponse,
  inviteBatchMax,
  inviteMaxExpiryDays,
  isNormalizableEmail,
  normalizeEmail,
} from "@symplist/contracts";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { IdempotencyKeys } from "@/lib/api";
import { useAccessApi } from "../../api.ts";
import { problemOf } from "../../errors.ts";
import { copyText } from "../../ui/clipboard.ts";
import { TextField } from "../../ui/field.tsx";
import { addDays, endOfLocalDay, formatDate, toDateInputValue } from "../../ui/format.ts";
import { useNavigationGuard } from "../../ui/navigation-guard.tsx";
import { Notice } from "../../ui/notice.tsx";
import { AdminHeader } from "../ui.tsx";

type Outcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "codes";
      readonly codes: readonly string[];
      readonly invites: readonly AdminInvite[];
    }
  /** An exact retry found the batch already created; the codes are gone for good (decision R11). */
  | {
      readonly kind: "already_issued";
      readonly invites: readonly AdminInvite[];
      readonly campaignId: string;
    }
  /** The request may or may not have created the batch: check before issuing another one. */
  | { readonly kind: "uncertain" };

const defaultExpiryDays = 7;

/**
 * Generate codes (admin_invite_create.md): one independent single-use code valid for seven days by
 * default, with a batch of independent codes and one shared campaign code as explicitly different
 * choices. The codes are shown once, here, and never again: Symplist stores only a digest and a hint,
 * and never sends a code to anyone.
 */
export function GenerateInvites() {
  const api = useAccessApi();
  const router = useRouter();
  const [mode, setMode] = useState<"independent" | "shared">("independent");
  const [count, setCount] = useState("1");
  const [maxRedemptions, setMaxRedemptions] = useState("1");
  const [expiry, setExpiry] = useState(toDateInputValue(addDays(Date.now(), defaultExpiryDays)));
  const [label, setLabel] = useState("");
  const [boundEmail, setBoundEmail] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: "none" });
  const [copied, setCopied] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  /** The exact request behind an uncertain outcome, so checking it replays the same fingerprint. */
  const [pending, setPending] = useState<GenerateInvitesRequest | null>(null);
  const keys = useMemo(() => new IdempotencyKeys(), []);

  const unacknowledged = outcome.kind === "codes" && !acknowledged;
  const guard = useNavigationGuard(unacknowledged, {
    title: "Leave before saving the codes?",
    description:
      "The full codes are shown only here. Leaving this page loses them, and lost codes can only be revoked and replaced.",
    confirmLabel: "Leave anyway",
    cancelLabel: "Stay and copy",
  });

  const validate = (): GenerateInvitesRequest | null => {
    const next: Record<string, string> = {};
    const countValue = mode === "shared" ? 1 : Number(count);
    if (!Number.isInteger(countValue) || countValue < 1 || countValue > inviteBatchMax) {
      next.count = `Generate between 1 and ${inviteBatchMax} codes.`;
    }
    const capValue = Number(maxRedemptions);
    if (!Number.isInteger(capValue) || capValue < 1) {
      next.maxRedemptions = "Enter how many people may redeem each code, at least 1.";
    }
    const expiresAt = endOfLocalDay(expiry);
    if (expiresAt === null) next.expiry = "Choose an expiry date.";
    else if (expiresAt <= Date.now() + 60_000) next.expiry = "Choose a date in the future.";
    else if (expiresAt > Date.now() + inviteMaxExpiryDays * 86_400_000) {
      next.expiry = `Codes can last at most ${inviteMaxExpiryDays} days.`;
    }
    const email = boundEmail.trim();
    if (email && !isNormalizableEmail(email)) next.boundEmail = "Enter a valid email address.";
    if (email && countValue !== 1) next.boundEmail = "A bound email applies to a single code.";
    setErrors(next);
    if (Object.keys(next).length > 0 || expiresAt === null) return null;
    return {
      mode,
      count: countValue,
      maxRedemptions: capValue,
      expiresAt,
      ...(label.trim() ? { label: label.trim() } : {}),
      ...(email ? { boundEmail: normalizeEmail(email) } : {}),
    };
  };

  const applyResponse = (response: GenerateInvitesResponse) => {
    if (response.secretUnavailable) {
      setOutcome({
        kind: "already_issued",
        invites: response.invites,
        campaignId: response.campaignId,
      });
    } else {
      setOutcome({ kind: "codes", codes: response.codes, invites: response.invites });
      setAcknowledged(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const request = validate();
    if (!request) return;
    setFailure(null);
    setBusy(true);
    setPending(request);
    try {
      applyResponse(await api.generateInvites(request, keys.acquire("generate")));
    } catch (error) {
      const problem = problemOf(error);
      const serverFault =
        problem.kind === "unexpected" || (problem.kind === "api" && problem.status >= 500);
      if (problem.kind === "network" || serverFault) {
        // The same key is kept, so checking the result can never mint a second batch (§6.1).
        setOutcome({ kind: "uncertain" });
      } else if (problem.kind === "throttled") {
        setFailure("Symplist is busy right now. Wait a moment and try again.");
      } else if (problem.kind === "api" && problem.code === "validation") {
        setFailure("Those settings weren't accepted. Check the expiry and the number of codes.");
      } else {
        setFailure("The codes couldn't be generated. Nothing was created.");
      }
    } finally {
      setBusy(false);
    }
  };

  const checkResult = async () => {
    const request = pending;
    if (!request || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      applyResponse(await api.generateInvites(request, keys.acquire("generate")));
    } catch (error) {
      const problem = problemOf(error);
      setFailure(
        problem.kind === "network"
          ? "Symplist still couldn't be reached. Try checking again in a moment."
          : "The result still couldn't be read. Try again in a moment.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, id: string) => {
    const ok = await copyText(value);
    setCopied(ok ? id : null);
    setCopyFailed(!ok);
  };

  const done = () => {
    setAcknowledged(true);
    keys.release("generate");
    router.push("/admin/invites");
  };

  if (outcome.kind === "codes") {
    const single = outcome.codes.length === 1;
    return (
      <div className="flex flex-col gap-5">
        <AdminHeader
          title={single ? "Your code" : `Your ${outcome.codes.length} codes`}
          description="Save these now. Full codes won't be shown again — Symplist keeps only a digest and a short hint."
        />
        <Notice tone="warning" title="Shown once" live="none">
          Copy the code{single ? "" : "s"} and share {single ? "it" : "them"} personally. If one is
          lost, revoke it and generate a replacement; nothing here can show it again.
        </Notice>
        {copyFailed ? (
          <Notice tone="error">
            The clipboard isn't available in this browser. Select the code text and copy it by hand.
          </Notice>
        ) : null}
        <ul className="m-0 flex list-none flex-col gap-2 p-0" data-slot="generated-codes">
          {outcome.codes.map((code, index) => {
            const invite = outcome.invites[index];
            return (
              <li
                key={code}
                className="flex flex-wrap items-center justify-between gap-3 rounded-sym-lg border border-sym-line bg-sym-surface px-3 py-2.5"
              >
                <code className="select-all break-all font-mono text-[14px]">{code}</code>
                <div className="flex items-center gap-2">
                  {invite ? (
                    <span className="text-[12px] text-sym-muted">
                      {formatInviteHint(invite.hint)}
                    </span>
                  ) : null}
                  <Button
                    size="sm"
                    onClick={() => {
                      void copy(code, code);
                    }}
                  >
                    {copied === code ? "Copied" : "Copy code"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex flex-wrap gap-2">
          {!single ? (
            <Button
              size="lg"
              onClick={() => {
                void copy(outcome.codes.join("\n"), "all");
              }}
            >
              {copied === "all" ? "All codes copied" : "Copy all codes"}
            </Button>
          ) : null}
          <Button variant="primary" size="lg" onClick={done}>
            Done
          </Button>
        </div>
        <p className="m-0 text-[12.5px] text-sym-muted">
          Closing this page doesn't save the codes anywhere. Invites lists only hints, labels and
          usage.
        </p>
        {guard.dialog}
      </div>
    );
  }

  if (outcome.kind === "already_issued") {
    return (
      <div className="flex flex-col gap-5">
        <AdminHeader
          title="These codes were already created"
          description="This request had already gone through, so its codes can't be shown again."
        />
        <Notice tone="warning" title="Nothing was created twice">
          The batch below exists already. Because codes are shown only once, revoke these and
          generate replacements if you never saw them.
        </Notice>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {outcome.invites.map((invite) => (
            <li key={invite.id} className="text-[13.5px]">
              <Link
                className="text-sym-link underline-offset-2 hover:underline"
                href={`/admin/invites/${invite.id}`}
              >
                {invite.label ?? "No label"} · {formatInviteHint(invite.hint)}
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Link
            className={buttonVariants({ variant: "primary", size: "lg" })}
            href={`/admin/invites?campaignId=${encodeURIComponent(outcome.campaignId)}`}
          >
            Review this batch
          </Link>
          <Button
            size="lg"
            onClick={() => {
              keys.release("generate");
              setOutcome({ kind: "none" });
            }}
          >
            Generate a new batch
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <AdminHeader
        title="Generate codes"
        description="Codes are created for you to keep and share personally. Symplist never emails them, and a bound email only restricts who may redeem."
        actions={
          <Link className={buttonVariants({ size: "lg" })} href="/admin/invites">
            Back to invites
          </Link>
        }
      />

      {outcome.kind === "uncertain" ? (
        <Notice
          tone="warning"
          title="We couldn't confirm the result"
          actions={
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                void checkResult();
              }}
            >
              {busy ? "Checking…" : "Check the result"}
            </Button>
          }
        >
          The request may or may not have created the codes. Check the result instead of generating
          another batch — checking uses the same request, so nothing is created twice.
        </Notice>
      ) : null}
      {failure ? <Notice tone="error">{failure}</Notice> : null}

      <form className="flex max-w-[460px] flex-col gap-4" onSubmit={submit} noValidate>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-1 p-0 font-medium text-[13px]">What to generate</legend>
          <label className="flex items-start gap-2 text-[13.5px]">
            <input
              type="radio"
              name="mode"
              className="mt-1"
              checked={mode === "independent"}
              onChange={() => setMode("independent")}
            />
            <span>
              <span className="font-medium">Independent codes</span>
              <span className="block text-[12.5px] text-sym-muted">
                One code per person. A batch generates several separate codes.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-[13.5px]">
            <input
              type="radio"
              name="mode"
              className="mt-1"
              checked={mode === "shared"}
              onChange={() => {
                setMode("shared");
                setCount("1");
              }}
            />
            <span>
              <span className="font-medium">One shared campaign code</span>
              <span className="block text-[12.5px] text-sym-muted">
                A single code several people can redeem, up to its cap.
              </span>
            </span>
          </label>
        </fieldset>

        <TextField
          label="Label or note"
          value={label}
          maxLength={100}
          placeholder="Friends — September"
          description="Private to administrators, encrypted at rest, and never shown to the person redeeming."
          onChange={(event) => setLabel(event.target.value)}
        />

        {mode === "independent" ? (
          <TextField
            label="How many codes"
            type="number"
            min={1}
            max={inviteBatchMax}
            step={1}
            inputMode="numeric"
            value={count}
            error={errors.count}
            onChange={(event) => setCount(event.target.value)}
          />
        ) : null}

        <TextField
          label={mode === "shared" ? "How many people may redeem it" : "Redemptions per code"}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={maxRedemptions}
          error={errors.maxRedemptions}
          description="Usage is never reset; to admit more people, raise the cap or generate more codes."
          onChange={(event) => setMaxRedemptions(event.target.value)}
        />

        <TextField
          label="Expires"
          type="date"
          value={expiry}
          min={toDateInputValue(Date.now())}
          max={toDateInputValue(addDays(Date.now(), inviteMaxExpiryDays - 1))}
          error={errors.expiry}
          description={`Valid until the end of that day. Default: ${formatDate(addDays(Date.now(), defaultExpiryDays))}.`}
          onChange={(event) => setExpiry(event.target.value)}
        />

        <div className="flex flex-col gap-3 rounded-sym-lg border border-sym-line p-3">
          <button
            type="button"
            className="cursor-pointer text-left font-medium text-[13px] text-sym-text"
            aria-expanded={advanced}
            aria-controls="advanced-options"
            onClick={() => setAdvanced((value) => !value)}
          >
            {advanced ? "Hide advanced options" : "Advanced options"}
          </button>
          <div id="advanced-options" hidden={!advanced} className="flex flex-col gap-3">
            <TextField
              label="Bind to an email address"
              type="email"
              value={boundEmail}
              error={errors.boundEmail}
              placeholder="maya@example.com"
              autoComplete="off"
              description="Only this address can redeem the code. Nothing is sent to it — you still share the code yourself. Applies to a single code."
              onChange={(event) => setBoundEmail(event.target.value)}
            />
          </div>
        </div>

        <div>
          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? <Spinner size={12} /> : null}
            {busy ? "Generating…" : "Generate codes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
