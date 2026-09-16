"use client";

import { formatInviteCode, normalizeInviteCode } from "@symplist/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { IdempotencyKeys } from "@/lib/api";
import { useAccessApi } from "../api.ts";
import { describeWait, problemOf } from "../errors.ts";
import { destinationPath, navigateAcrossGroups } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { inputClassName } from "../ui/field.tsx";
import { Notice } from "../ui/notice.tsx";
import { formatCountdown, useCountdown } from "../ui/use-countdown.ts";
import { IdentityMenu } from "./identity-menu.tsx";
import { useDestinationGuard } from "./use-destination-guard.ts";

interface Message {
  readonly tone: "error" | "warning" | "success" | "info";
  readonly title?: string;
  readonly text: string;
  readonly blockedUntil?: number;
}

/**
 * The beta gate (beta_gate.md): a verified account that is signed in but not admitted. No task,
 * document, chat, vault or connector content renders behind this screen — the app is simply not
 * mounted. One paste-friendly code field unlocks the account; Check access picks up an administrator's
 * direct unlock without sending anything.
 */
export function BetaGate() {
  const api = useAccessApi();
  const controls = useSessionControls();
  const router = useRouter();
  const { me, allowed } = useDestinationGuard(["beta_gate"]);
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const keys = useRef(new IdempotencyKeys());
  const blocked = useCountdown(message?.blockedUntil ?? null);

  if (!me || !allowed) {
    return (
      <EntryFrame>
        <p role="status" className="text-[13.5px] text-sym-muted">
          Opening your account…
        </p>
      </EntryFrame>
    );
  }

  const canonical = normalizeInviteCode(code);
  const locked = blocked > 0;
  const busy = redeeming || checking;

  const redeem = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || locked) return;
    const entered = code.trim();
    if (entered.length === 0) {
      setMessage({ tone: "warning", text: "Enter the invite code that was shared with you." });
      return;
    }
    const scope = canonical ?? entered;
    setRedeeming(true);
    setMessage(null);
    try {
      const result = await api.redeem(entered, keys.current.acquire(scope));
      keys.current.release(scope);
      controls.setMe(result.me);
      setMessage({
        tone: "success",
        text:
          result.outcome === "already_unlocked"
            ? "Your account is already unlocked. Opening Symplist…"
            : "Access unlocked. Opening Symplist…",
      });
      navigateAcrossGroups(router, destinationPath(result.me), { replace: true });
    } catch (error) {
      const problem = problemOf(error);
      if (problem.kind === "network") {
        // The same key is kept, so a retry of this intent can never take a second seat.
        setMessage({
          tone: "error",
          text: "Symplist couldn't be reached. Your code is still here — try again.",
        });
      } else if (problem.kind === "throttled") {
        setMessage({
          tone: "warning",
          title: "Too many tries",
          text:
            problem.retryAfterSeconds === null
              ? "Wait a moment before trying another code."
              : `Wait ${describeWait(problem.retryAfterSeconds)} before trying another code.`,
          ...(problem.retryAfterSeconds === null
            ? {}
            : { blockedUntil: Date.now() + problem.retryAfterSeconds * 1000 }),
        });
      } else if (problem.kind === "api" && problem.code === "invite.invalid") {
        keys.current.release(scope);
        setMessage({
          tone: "error",
          title: "That code can't be used",
          text: "It may be mistyped, already used, expired, withdrawn, or meant for another address. Check it, or ask the person who shared it for a new one.",
        });
      } else if (
        problem.kind === "api" &&
        (problem.code === "access.relocked" || problem.code === "access.suspended")
      ) {
        keys.current.release(scope);
        await controls.refresh();
      } else if (problem.kind === "api" && problem.code === "idempotency.mismatch") {
        keys.current.release(scope);
        setMessage({
          tone: "warning",
          text: "That request was already used with a different code. Try the code again.",
        });
      } else {
        setMessage({ tone: "error", text: "Something went wrong on our side. Try again." });
      }
    } finally {
      setRedeeming(false);
    }
  };

  const checkAccess = async () => {
    if (busy || locked) return;
    setChecking(true);
    setMessage(null);
    const before = me.destination;
    const snapshot = await controls.refresh();
    setChecking(false);
    if (snapshot.loadError) {
      setMessage({
        tone: "error",
        text:
          snapshot.loadError === "network"
            ? "Symplist couldn't be reached. Check your connection and try again."
            : "We couldn't check your access just now. Try again in a moment.",
      });
      return;
    }
    if (snapshot.me && snapshot.me.destination !== before) {
      setMessage({ tone: "success", text: "Access granted. Opening Symplist…" });
      return;
    }
    setMessage({
      tone: "info",
      text: "No change yet — your account is still waiting for an invite code.",
    });
  };

  return (
    <EntryFrame headerEnd={<IdentityMenu me={me} />}>
      <div className="flex flex-col gap-2">
        <ScreenHeading>You're signed in</ScreenHeading>
        <Lede>
          Symplist is in closed beta. Enter an invite code shared with you to unlock your account.
        </Lede>
      </div>
      <form className="flex flex-col gap-3" onSubmit={redeem} noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invite-code" className="font-medium text-[13px] text-sym-text">
            Invite code
          </label>
          <input
            id="invite-code"
            name="invite-code"
            className={`${inputClassName} h-12 font-mono text-[15px] tracking-[0.04em] md:h-12 md:text-[15px]`}
            value={code}
            placeholder="SYM-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            disabled={redeeming || locked}
            aria-describedby="invite-code-help"
            onChange={(event) => {
              const value = event.target.value;
              // A pasted code is shown in its readable groups at once; typing is left alone until
              // the field loses focus, so the grouping never jumps under the caret.
              const pasted =
                (event.nativeEvent as InputEvent | undefined)?.inputType === "insertFromPaste";
              const normalized = pasted ? normalizeInviteCode(value) : null;
              setCode(normalized ? formatInviteCode(normalized) : value);
              if (message?.tone === "error") setMessage(null);
            }}
            onBlur={(event) => {
              const normalized = normalizeInviteCode(event.target.value);
              if (normalized) setCode(formatInviteCode(normalized));
            }}
          />
          <p id="invite-code-help" className="m-0 text-[12.5px] text-sym-muted">
            Paste the whole code; spaces, dashes and capitals don't matter.
          </p>
        </div>
        {message ? (
          <Notice
            tone={message.tone}
            {...(message.title ? { title: message.title } : {})}
            live={message.tone === "info" ? "auto" : undefined}
          >
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
          disabled={busy || locked || code.trim().length === 0}
          aria-busy={redeeming || undefined}
        >
          {redeeming ? <Spinner size={12} /> : null}
          {redeeming ? "Unlocking…" : "Unlock account"}
        </Button>
      </form>
      <div className="flex flex-col gap-2 border-sym-line border-t pt-4">
        <p className="m-0 text-[13px] text-sym-muted [text-wrap:pretty]">
          Don't have a code? You can return when one is shared with you. Symplist's owner sends
          codes personally — there's no waiting list and nothing to request here.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="md"
            disabled={busy || locked}
            aria-busy={checking || undefined}
            onClick={() => {
              void checkAccess();
            }}
          >
            {checking ? <Spinner size={11} /> : null}
            {checking ? "Checking…" : "Check access"}
          </Button>
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              void controls.signOut();
            }}
          >
            Sign out
          </Button>
        </div>
        <p className="m-0 text-[12.5px] text-sym-muted">
          Signed in as {me.user.email}. If an administrator unlocks your account, Check access picks
          it up — it never sends a code.
        </p>
      </div>
    </EntryFrame>
  );
}
