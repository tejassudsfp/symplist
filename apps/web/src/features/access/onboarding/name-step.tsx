"use client";

import { displayNameMaxLength } from "@symplist/contracts";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAccessApi } from "../api.ts";
import { problemOf } from "../errors.ts";
import { IdentityMenu } from "../gate/identity-menu.tsx";
import { useDestinationGuard } from "../gate/use-destination-guard.ts";
import { ONBOARDING_CONNECTIONS_PATH } from "../navigation.ts";
import { useSessionControls } from "../session.tsx";
import { EntryFrame, Lede, ScreenHeading } from "../ui/entry-frame.tsx";
import { TextField } from "../ui/field.tsx";
import { Notice } from "../ui/notice.tsx";
import { OnboardingProgress } from "./onboarding-steps.tsx";

/**
 * Onboarding, step one (onboarding_name.md): the only question Symplist asks before the workspace.
 * A saved name is prefilled so a resumed or revisited flow has no second welcome, and a failed save
 * keeps what was typed. Going back never re-locks the account or asks for another invite.
 */
export function OnboardingName() {
  const api = useAccessApi();
  const controls = useSessionControls();
  const router = useRouter();
  const { me, allowed } = useDestinationGuard(["onboarding"]);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const prefilled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const saved = me?.user.displayName ?? null;

  useEffect(() => {
    if (prefilled.current || saved === null) return;
    prefilled.current = true;
    setName(saved);
  }, [saved]);

  if (!me || !allowed) {
    return (
      <EntryFrame>
        <p role="status" className="text-[13.5px] text-sym-muted">
          Opening Symplist…
        </p>
      </EntryFrame>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
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
    setSaving(true);
    try {
      const next = await api.updateDisplayName(value);
      controls.setMe(next);
      router.push(ONBOARDING_CONNECTIONS_PATH);
    } catch (error) {
      const problem = problemOf(error);
      if (problem.kind === "api" && problem.code === "validation") {
        setInvalid("That name can't be used. Try letters, numbers and spaces.");
      } else if (problem.kind === "network") {
        setFailure("Symplist couldn't be reached, so your name wasn't saved. Try again.");
      } else if (problem.kind === "session_expired") {
        setFailure("Your session has ended. Sign in again to continue.");
      } else {
        setFailure("Something went wrong on our side, so your name wasn't saved. Try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <EntryFrame headerEnd={<IdentityMenu me={me} />}>
      <OnboardingProgress current="name" />
      <div className="flex flex-col gap-2">
        <ScreenHeading>What should we call you?</ScreenHeading>
        {saved === null ? (
          <Lede>
            Welcome to Symplist. Your name shows up in your profile menu and nowhere else.
          </Lede>
        ) : (
          <Lede>This is the name in your profile menu. Change it here any time during setup.</Lede>
        )}
      </div>
      <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
        <TextField
          ref={inputRef}
          label="Name"
          name="name"
          autoComplete="name"
          enterKeyHint="go"
          placeholder="Maya"
          maxLength={displayNameMaxLength * 2}
          value={name}
          disabled={saving}
          error={invalid}
          description={`Up to ${displayNameMaxLength} characters. You can change it later in Settings → Account.`}
          onChange={(event) => {
            setName(event.target.value);
            if (invalid) setInvalid(null);
          }}
        />
        {failure ? <Notice tone="error">{failure}</Notice> : null}
        <Button
          type="submit"
          variant="primary"
          size="lg"
          className="w-full"
          disabled={saving}
          aria-busy={saving || undefined}
        >
          {saving ? <Spinner size={12} /> : null}
          {saving ? "Saving…" : "Continue"}
        </Button>
      </form>
    </EntryFrame>
  );
}
