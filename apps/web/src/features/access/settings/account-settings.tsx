"use client";

import { displayNameMaxLength } from "@symplist/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { type SaveState, SaveStatus } from "@/components/ui/save-status";
import { Spinner } from "@/components/ui/spinner";
import { AccessSummary } from "../account/access-summary.tsx";
import { DeleteAccount } from "../account/delete-account.tsx";
import { useAccessApi } from "../api.ts";
import { problemOf } from "../errors.ts";
import { useSessionControls } from "../session.tsx";
import { TextField } from "../ui/field.tsx";
import { useNavigationGuard } from "../ui/navigation-guard.tsx";
import { Notice } from "../ui/notice.tsx";

/**
 * Settings → Account (settings_account.md): the display name, the verified email as read-only text, a
 * restrained beta-access indicator, sign-out, the analytics feature's Privacy section, and account
 * deletion kept in its own danger area with a fresh emailed confirmation. The settings shell around
 * it comes from the route layout, so this renders the Account section alone.
 */
export function AccountSettings() {
  const api = useAccessApi();
  const controls = useSessionControls();
  const me = controls.me;
  const saved = me?.user.displayName ?? "";
  const [name, setName] = useState(saved);
  const [state, setState] = useState<SaveState | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const initialized = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initialized.current || !me) return;
    initialized.current = true;
    setName(me.user.displayName ?? "");
  }, [me]);

  const dirty = name.replace(/\s+/gu, " ").trim() !== saved.trim();
  const guard = useNavigationGuard(dirty, {
    title: "Leave without saving your name?",
    description: "Your new name hasn't been saved yet. Leaving now keeps the name you had before.",
    confirmLabel: "Discard changes",
    cancelLabel: "Keep editing",
  });

  if (!me) {
    return (
      <p role="status" className="text-[13.5px] text-sym-muted">
        Loading your account…
      </p>
    );
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state?.kind === "saving") return;
    const value = name.replace(/\s+/gu, " ").trim();
    if (value.length === 0) {
      setInvalid("Enter a name so Symplist knows what to call you.");
      inputRef.current?.focus();
      return;
    }
    if (value.length > displayNameMaxLength) {
      setInvalid(`Names can be up to ${displayNameMaxLength} characters.`);
      inputRef.current?.focus();
      return;
    }
    setInvalid(null);
    setFailure(null);
    setState({ kind: "saving" });
    try {
      const next = await api.updateDisplayName(value);
      controls.setMe(next);
      setName(next.user.displayName ?? value);
      setState({ kind: "saved", at: new Date() });
    } catch (error) {
      const problem = problemOf(error);
      // The typed name is kept, so nothing has to be written again.
      setState({
        kind: "failed",
        onRetry: () => {
          void save(event);
        },
      });
      if (problem.kind === "api" && problem.code === "validation") {
        setInvalid("That name can't be used. Try letters, numbers and spaces.");
      } else if (problem.kind === "network") {
        setFailure("Symplist couldn't be reached, so your name wasn't saved. Try again.");
      } else if (problem.kind === "session_expired") {
        setFailure("Your session has ended. Sign in again to save your name.");
      } else {
        setFailure("Something went wrong on our side, so your name wasn't saved. Try again.");
      }
    }
  };

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="m-0 font-heading font-semibold text-[20px] tracking-[-0.01em]">Account</h1>
        <p className="m-0 text-[13.5px] text-sym-muted">
          Your identity in Symplist, and what happens if you want to leave.
        </p>
      </header>

      <section aria-labelledby="display-name-title" className="flex flex-col gap-3">
        <h2 id="display-name-title" className="m-0 font-heading font-semibold text-[15px]">
          Display name
        </h2>
        <form className="flex max-w-[380px] flex-col gap-3" onSubmit={save} noValidate>
          <TextField
            ref={inputRef}
            label="Name"
            name="display-name"
            autoComplete="name"
            maxLength={displayNameMaxLength * 2}
            value={name}
            disabled={state?.kind === "saving"}
            error={invalid}
            description="Shown in your profile menu. Only you see it."
            onChange={(event) => {
              setName(event.target.value);
              if (invalid) setInvalid(null);
              if (state?.kind !== "saving") setState({ kind: "unsaved" });
            }}
          />
          {failure ? <Notice tone="error">{failure}</Notice> : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={state?.kind === "saving" || !dirty}
              aria-busy={state?.kind === "saving" || undefined}
            >
              {state?.kind === "saving" ? <Spinner size={12} /> : null}
              {state?.kind === "saving" ? "Saving…" : "Save name"}
            </Button>
            {state ? <SaveStatus state={state} /> : null}
          </div>
        </form>
      </section>

      <section aria-labelledby="identity-title" className="flex flex-col gap-3">
        <h2 id="identity-title" className="m-0 font-heading font-semibold text-[15px]">
          Identity
        </h2>
        <AccessSummary me={me} />
        <p className="m-0 text-[12.5px] text-sym-muted">
          Your email address is fixed for this release. Signing in always uses a code sent to it.
        </p>
        <div>
          <Button
            variant="secondary"
            size="lg"
            onClick={() => {
              void controls.signOut();
            }}
          >
            Sign out
          </Button>
        </div>
      </section>

      {/*
        Privacy (product analytics consent) belongs to the analytics feature (§15, decision D5); it
        mounts its section here, next to the rest of the account settings.
      */}
      <div data-slot="account-privacy" />

      <DeleteAccount me={me} />
      {guard.dialog}
    </>
  );
}
