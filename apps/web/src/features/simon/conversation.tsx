"use client";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { PermissionCard } from "./permission-card.tsx";
import { type ChatItem, permissionSubject, selectOption } from "./projection.ts";
import { useChatState } from "./provider.tsx";
import { SessionSetup } from "./session-setup.tsx";
import { type ChatStore, canCancelChat, canSendChat } from "./store.ts";
import { ToolCallCard } from "./tool-call.tsx";
import { WorkingStrip } from "./working-strip.tsx";

/**
 * The chat pane: the transcript, the composer, and the model selector the harness advertises.
 *
 * The transcript is a flat list rather than nested bubbles, because a tool call is not part of a message
 * — the harness interleaves prose, reasoning and tool lifecycle as separate committed facts, and
 * flattening them is the rendering that matches the wire. Each item knows how to draw itself and nothing
 * here decides what an item means; that is all in `projection.ts`.
 */
function stopReasonNote(reason: string | null): string | null {
  if (reason === null || reason === "end_turn") return null;
  if (reason === "cancelled") return "Stopped. Anything already done was not undone.";
  if (reason === "max_tokens")
    return "Simon ran out of room in this conversation. Start a new one to keep going.";
  if (reason === "max_turn_requests")
    return "Simon reached its step limit for one turn. Ask again to continue.";
  if (reason === "refusal") return "Simon declined to continue with that.";
  return null;
}

function ItemView({ item }: { readonly item: ChatItem }) {
  if (item.kind === "user")
    return (
      <Message from="user">
        <span className="sr-only">You</span>
        <MessageContent>
          <p className="m-0 whitespace-pre-wrap">{item.text}</p>
        </MessageContent>
      </Message>
    );
  if (item.kind === "assistant")
    return (
      <Message from="assistant">
        <span className="sr-only">Simon</span>
        <MessageContent>
          <MessageResponse>{item.text}</MessageResponse>
        </MessageContent>
      </Message>
    );
  if (item.kind === "thought")
    return (
      // The agent's working-out, folded away by default. It is not the answer and must not read like it.
      <details className="min-w-0 rounded-sym border border-sym-line px-2.5 py-1.5 text-[12.5px] text-sym-muted">
        <summary className="cursor-pointer list-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus">
          Simon’s thinking
        </summary>
        <p className="m-0 mt-1 whitespace-pre-wrap">{item.text}</p>
      </details>
    );
  return <ToolCallCard call={item} />;
}

export function SimonConversation({
  store,
  taskId,
}: {
  readonly store: ChatStore;
  readonly taskId: string | null;
}) {
  const state = useChatState(store, taskId);
  const composer = useRef<HTMLTextAreaElement>(null);
  const { projection } = state;
  const model = selectOption(projection, "model");
  const subject = useMemo(() => permissionSubject(projection), [projection]);
  const working = state.phase === "working" || state.phase === "awaiting_permission";
  const note = working ? null : stopReasonNote(projection.stopReason);

  // The composer takes focus when a turn finishes, so the next message needs no click. It is deliberately
  // not taken while a turn runs: stealing focus mid-turn would fight whatever the person moved to.
  useEffect(() => {
    if (state.phase === "idle" && document.activeElement === document.body)
      composer.current?.focus();
  }, [state.phase]);

  if (!state.conversationId)
    return (
      <SessionSetup
        state={state}
        bridge={store.bridge}
        taskId={taskId}
        onOpen={(cwd) => void store.open(taskId, { cwd })}
      />
    );

  const send = () => void store.send(taskId);
  const cancel = () => void store.cancel(taskId);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation>
        <ConversationContent>
          {state.nextBeforeSeq !== null ? (
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              disabled={state.loadingHistory}
              onClick={() => void store.loadOlder(taskId)}
            >
              {state.loadingHistory ? "Loading earlier messages…" : "Load earlier messages"}
            </Button>
          ) : null}
          {!projection.items.length && !state.loadingHistory ? (
            <div className="flex flex-col gap-2 text-[13px] text-sym-muted">
              <p className="m-0">
                {taskId
                  ? "Ask Simon about this task. It can run things in this folder and edit the task’s page one section at a time."
                  : "Ask Simon anything. It can run things in this folder and edit your task pages."}
              </p>
              <p className="m-0 font-mono text-[11.5px]">{state.cwd}</p>
            </div>
          ) : null}
          {projection.items.map((item, index) => (
            <div key={itemKey(item, index)} className="flex min-w-0 flex-col gap-2">
              <ItemView item={item} />
              {projection.memoryResetAfter === index + 1 ? <MemoryDivider /> : null}
            </div>
          ))}
          {working ? <WorkingStrip projection={projection} stopping={state.stopping} /> : null}
          {projection.pendingPermission ? (
            <PermissionCard
              key={projection.pendingPermission.requestId}
              request={projection.pendingPermission}
              subject={subject}
              busy={state.stopping}
              onAnswer={(optionId) => void store.answerPermission(taskId, optionId)}
            />
          ) : null}
          {note ? (
            <p role="status" className="m-0 text-[12.5px] text-sym-muted">
              {note}
            </p>
          ) : null}
          {state.failure ? (
            <InlineError
              title="Simon could not finish that"
              description={state.failure.message}
              retryLabel="Dismiss"
              onRetry={() => store.dismissFailure(taskId)}
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <form
        className="flex shrink-0 flex-col gap-1.5 border-sym-line border-t px-3.5 pt-2.5 pb-3"
        data-action-context="composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSendChat(state)) send();
        }}
      >
        <label className="sr-only" htmlFor={`simon-compose-${taskId ?? "workspace"}`}>
          Message Simon
        </label>
        <textarea
          ref={composer}
          id={`simon-compose-${taskId ?? "workspace"}`}
          value={state.draft}
          placeholder={working ? "Simon is working…" : "Ask Simon…"}
          maxLength={32_000}
          rows={2}
          // Hard-disabled rather than queued: ACP admits exactly one prompt per session, so a queue would
          // be a promise this transport cannot keep.
          disabled={working}
          onChange={(event) => store.draft(taskId, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && canCancelChat(state)) {
              event.preventDefault();
              cancel();
              return;
            }
            // Enter sends, Shift+Enter writes a new line. This belongs to the textarea rather than a
            // keyboard binding: the action dispatcher ignores every unmodified key while someone is
            // typing (note 13), so a registered `enter` would never fire here. IME composition has to
            // finish first, or Enter picking a candidate would send a half-typed line.
            if (event.key !== "Enter" || event.shiftKey || event.altKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSendChat(state)) send();
          }}
          className="min-h-[52px] w-full resize-none rounded-sym border border-sym-line-strong bg-sym-surface px-2.5 py-2 text-[13.5px] text-sym-text placeholder:text-sym-faint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus disabled:opacity-70"
        />
        <div className="flex min-w-0 items-center gap-2">
          {model?.options?.length ? (
            <label className="flex min-w-0 items-center gap-1.5 text-[12px] text-sym-muted">
              <span className="sr-only">Simon’s model</span>
              <select
                aria-label="Simon’s model"
                value={typeof model.currentValue === "string" ? model.currentValue : ""}
                // A change applies to the next turn, which is the harness's rule, not a limitation we
                // chose: a prompt pins its route when it is admitted.
                disabled={working}
                onChange={(event) => void store.setConfig(taskId, model.id, event.target.value)}
                className="h-7 min-w-0 max-w-[180px] truncate rounded-sym border border-sym-line-strong bg-sym-surface px-1.5 text-[12px] text-sym-text"
              >
                {model.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {projection.usage ? (
            <span className="shrink-0 text-[11.5px] text-sym-faint tabular-nums">
              {Math.round((projection.usage.used / Math.max(projection.usage.size, 1)) * 100)}% of
              context
            </span>
          ) : null}
          <span className="flex-1" />
          {canCancelChat(state) ? (
            <Button type="button" size="sm" variant="secondary" onClick={cancel}>
              <SquareIcon size={11} aria-hidden="true" />
              Stop
            </Button>
          ) : null}
          <Button
            type="submit"
            size="icon"
            variant="primary"
            disabled={!canSendChat(state)}
            aria-label="Send message"
          >
            <ArrowUpIcon size={15} aria-hidden="true" />
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * A stable key per item. Tool calls and assistant messages carry their own ids; a user message added
 * locally does too. The index is the tiebreak for the one case ACP allows and the harness does not use —
 * a chunk with no `messageId` — and nothing is ever reordered, so it is stable in practice.
 */
function itemKey(item: ChatItem, index: number): string {
  if (item.kind === "tool") return `tool:${item.toolCallId}`;
  if (item.kind === "user") return `user:${item.id}`;
  return `${item.kind}:${item.messageId}:${index}`;
}

/**
 * The line that says the agent has forgotten what is above it.
 *
 * ACP has no transcript replay, so a conversation whose dsh session is gone keeps our history and loses
 * the agent's. Hiding that would mean the person asks a follow-up about something the agent has never
 * heard of and gets a confusing answer; this is the honest cost of not owning dsh's context.
 */
function MemoryDivider() {
  return (
    <p
      role="status"
      className="m-0 flex items-center gap-2 text-[11.5px] text-sym-faint before:h-px before:flex-1 before:bg-sym-line before:content-[''] after:h-px after:flex-1 after:bg-sym-line after:content-['']"
    >
      Simon does not remember the messages above this line
    </p>
  );
}
