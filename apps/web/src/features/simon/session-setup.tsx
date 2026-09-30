"use client";
import { FolderOpenIcon } from "lucide-react";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Spinner } from "@/components/ui/spinner";
import type { ChatBridge } from "./bridge.ts";
import type { ChatState } from "./store.ts";

/**
 * What the pane shows before a conversation has a session: the project folder it will work in.
 *
 * A conversation owns a directory because ACP makes it own one — a session pins a single absolute `cwd`
 * and "additional directories remain unsupported" — so this is asked once and then never again for that
 * conversation. It is also the honest moment to say what the person is agreeing to: an assistant with a
 * shell in a folder they chose, which is the entire difference between this app and the web one.
 */
export function SessionSetup({
  state,
  bridge,
  taskId,
  onOpen,
}: {
  readonly state: ChatState;
  readonly bridge: ChatBridge;
  readonly taskId: string | null;
  readonly onOpen: (cwd: string) => void;
}) {
  const [cwd, setCwd] = useState(state.cwd ?? "");
  const [choosing, setChoosing] = useState(false);
  const fieldId = useId();
  const opening = state.phase === "opening";
  const choose = async () => {
    setChoosing(true);
    try {
      const chosen = await bridge.chooseDirectory();
      if (chosen) setCwd(chosen);
    } finally {
      setChoosing(false);
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3.5 py-4">
      <div className="flex flex-col gap-1">
        <h3 className="m-0 font-heading font-semibold text-[14px]">Where should Simon work?</h3>
        <p className="m-0 text-[13px] text-sym-muted">
          {taskId
            ? "Pick the folder for this task. Simon can read and run things there, and can edit this task’s page through your workspace."
            : "Pick a folder. Simon can read and run things there, and can edit your task pages through your workspace."}
        </p>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (cwd.trim()) onOpen(cwd.trim());
        }}
      >
        <label className="sr-only" htmlFor={fieldId}>
          Project folder
        </label>
        <div className="flex min-w-0 items-center gap-2">
          <input
            id={fieldId}
            value={cwd}
            placeholder="/Users/you/projects/something"
            spellCheck={false}
            autoComplete="off"
            disabled={opening}
            onChange={(event) => setCwd(event.target.value)}
            className="h-8 min-w-0 flex-1 rounded-sym border border-sym-line-strong bg-sym-surface px-2 font-mono text-[12.5px] text-sym-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={choosing || opening}
            onClick={() => void choose()}
          >
            <FolderOpenIcon size={13} strokeWidth={2.2} aria-hidden="true" />
            Choose…
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" variant="primary" disabled={!cwd.trim() || opening}>
            {opening ? "Starting…" : "Start"}
          </Button>
          {opening ? <Spinner /> : null}
        </div>
      </form>
      {state.failure ? (
        <InlineError
          title="Simon could not start here"
          description={describeSetupFailure(state.failure)}
        />
      ) : null}
      <p className="m-0 text-[12px] text-sym-muted">
        {/* Note 18, permanently: no conversation is ever stored in the cloud again. */}
        This conversation is stored on this machine and never sent to the cloud.
      </p>
    </div>
  );
}

/**
 * A failure from `start`, in words that point somewhere.
 *
 * The three-way split the cloud had — the deployment cannot run models / this account has no key /
 * something broke — is not fully available over this wire, and pretending otherwise would be dishonest.
 * A missing credential is only distinguishable when main names it, so the codes main can actually
 * establish are the ones handled, and everything else says what happened without diagnosing it.
 */
export function describeSetupFailure(failure: { code: string; message: string }): string {
  if (failure.code === "chat.key_required")
    return "Simon runs on your own model key, and this machine does not have one yet. Add one in Settings → Models; it is stored in your keychain and never leaves this device.";
  if (failure.code === "chat.harness_missing")
    return "The assistant did not start. Reopen the app; if it keeps happening the harness could not be launched.";
  if (failure.code === "chat.cwd_invalid")
    return "That path is not a folder this app can open. Choose one that exists.";
  return failure.message;
}
