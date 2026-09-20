"use client";
import { MessageCircleIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { track } from "@/features/analytics/runtime";
import { useOptionalWorkspace } from "@/features/workspace/workspace-provider";
import type { SimonApi } from "./api.ts";
import { SimonConversation } from "./conversation.tsx";
import { useChatState, useSimon } from "./provider.tsx";
import type { SimonStore } from "./store.ts";

export function QuickChatLauncher() {
  const store = useSimon();
  const workspace = useOptionalWorkspace();
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement>(null);
  if (!store || workspace?.openTaskId) return null;
  return (
    <>
      <Button
        ref={launcher}
        className="sym-quick-chat-launcher"
        onClick={() => {
          track("quick_chat_started", { entry: "button" });
          setOpen(true);
        }}
        aria-expanded={open}
      >
        <MessageCircleIcon size={16} aria-hidden="true" />
        Ask Simon
      </Button>
      {open ? (
        <QuickChatDialog
          store={store}
          onClose={() => setOpen(false)}
          finalFocus={launcher}
          onSaved={(saved) => workspace?.openTask(saved.collection, saved.taskId)}
        />
      ) : null}
    </>
  );
}

function QuickChatDialog({
  store,
  onClose,
  finalFocus,
  onSaved,
}: {
  store: SimonStore;
  onClose: () => void;
  finalFocus: React.RefObject<HTMLButtonElement | null>;
  onSaved: (saved: Awaited<ReturnType<SimonApi["save"]>>) => void;
}) {
  const state = useChatState(store, null);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const [collection, setCollection] = useState<"now" | "later" | "unclassified">("now");
  const cleanupGeneration = useRef(0);
  const unmounted = useRef(false);
  const savedAsTask = useRef(false);
  const operation = useRef<"close" | "save" | null>(null);
  const disabled = state.busy || state.uncertain || !state.conversationId;

  useEffect(() => {
    cleanupGeneration.current++;
    unmounted.current = false;
    return () => {
      const generation = ++cleanupGeneration.current;
      // Strict Mode immediately mounts this effect again with the same dialog instance. Deferring
      // distinguishes that rehearsal from a task/route change that truly removed the quick chat.
      queueMicrotask(() => {
        if (cleanupGeneration.current !== generation) return;
        unmounted.current = true;
        if (!savedAsTask.current && operation.current === null) void store.discardQuick();
      });
    };
  }, [store]);

  const discardAfterInterruptedOperation = () => {
    if (unmounted.current && !savedAsTask.current) void store.discardQuick();
  };
  const close = async () => {
    if (state.busy || state.uncertain) return;
    operation.current = "close";
    const closed = await store.closeQuick(onClose);
    operation.current = null;
    if (!closed) discardAfterInterruptedOperation();
  };
  const save = async () => {
    const id = state.conversationId;
    if (!id || !title.trim() || disabled || state.projection.view?.activeRun) return;
    let saved: Awaited<ReturnType<SimonApi["save"]>> | null = null;
    operation.current = "save";
    const completed = await store.command(
      null,
      async (key) => {
        saved = await store.api.save(id, { title: title.trim(), collection }, key);
        return saved;
      },
      () => {
        savedAsTask.current = true;
        store.forgetQuick();
        onClose();
        if (saved) onSaved(saved);
      },
    );
    operation.current = null;
    if (!completed) discardAfterInterruptedOperation();
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) void close();
      }}
    >
      <DialogContent className="sym-quick-chat-dialog" finalFocus={finalFocus}>
        <header className="sym-quick-chat-header">
          <div>
            <DialogTitle>Simon</DialogTitle>
            <DialogDescription>Workspace helper · temporary chat</DialogDescription>
          </div>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close and delete quick chat"
            disabled={state.busy || state.uncertain}
            onClick={() => void close()}
          >
            <XIcon size={16} aria-hidden="true" />
          </Button>
        </header>
        <p className="sym-simon-note sym-quick-chat-notice">
          Deleted when you close it. Otherwise expires after 24 hours without activity.
        </p>
        <SimonConversation store={store} taskId={null} />
        <footer className="sym-quick-chat-footer">
          {saving ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <label>
                Task title
                <input
                  className="sym-simon-title-input"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  required
                  maxLength={200}
                  disabled={disabled}
                />
              </label>
              <label>
                Collection
                <select
                  value={collection}
                  onChange={(event) =>
                    setCollection(
                      event.target.value === "later"
                        ? "later"
                        : event.target.value === "unclassified"
                          ? "unclassified"
                          : "now",
                    )
                  }
                  disabled={disabled}
                >
                  <option value="now">Now</option>
                  <option value="later">Later</option>
                  <option value="unclassified">Unclassified</option>
                </select>
              </label>
              <Button
                type="submit"
                disabled={disabled || !title.trim() || !!state.projection.view?.activeRun}
              >
                Save task
              </Button>
              <Button
                type="button"
                disabled={state.busy || state.uncertain}
                onClick={() => setSaving(false)}
              >
                Cancel
              </Button>
            </form>
          ) : (
            <Button
              size="sm"
              disabled={disabled || !!state.projection.view?.activeRun}
              onClick={() => setSaving(true)}
            >
              Save as task
            </Button>
          )}
          {state.projection.view?.activeRun ? (
            <p className="sym-simon-note">
              Finish or stop the current work before saving as a task.
            </p>
          ) : null}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
