"use client";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { useOptionalActions } from "@/actions/provider";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/ui/inline-error";
import { Activity } from "./activity.tsx";
import { ApprovalCard } from "./approval-card.tsx";
import { registerChat } from "./controller.ts";
import { projectedMessages } from "./projection.ts";
import { useChatState } from "./provider.tsx";
import { canSendChat, type SimonStore } from "./store.ts";

export function SimonConversation({ store, taskId }: { store: SimonStore; taskId: string | null }) {
  const state = useChatState(store, taskId);
  const actions = useOptionalActions();
  const latest = useRef(state);
  latest.current = state;
  const view = state.projection.view;
  const run = view?.activeRun;
  const messages = projectedMessages(state.projection);
  const disabled = state.busy || state.uncertain || !view;
  useEffect(
    () =>
      registerChat({
        canSend: () => canSendChat(latest.current),
        canStop: () =>
          !!latest.current.projection.view?.activeRun &&
          !latest.current.busy &&
          !latest.current.uncertain,
        send: async () => {
          await store.send(taskId);
        },
        stop: async () => {
          const id = latest.current.projection.view?.activeRun?.runId;
          if (id) await store.command(taskId, (key) => store.api.stop(id, key));
        },
      }),
    [store, taskId],
  );
  const send = () => {
    if (actions) void actions.invoke("simon.send_message", "pointer", "chat");
    else void store.send(taskId);
  };
  const stop = () => {
    if (actions) void actions.invoke("simon.stop", "pointer", "chat");
    else if (run) void store.command(taskId, (key) => store.api.stop(run.runId, key));
  };
  const terminal = !run ? view?.latestRun : null;
  return (
    <div className="sym-simon-conversation">
      {!["open", "idle"].includes(state.connection) ? (
        <p role="status" className="sym-simon-note">
          {state.connection === "offline"
            ? "Live updates are unavailable. Reload the conversation to check saved progress."
            : state.connection === "unauthorized" || state.connection === "forbidden"
              ? "This conversation is no longer available."
              : "Reconnecting… Simon’s work is independent of this panel. Saved history will reload."}
        </p>
      ) : null}
      <Conversation>
        <ConversationContent>
          {view?.nextBeforeSeq != null ? (
            <Button
              size="sm"
              disabled={state.loadingOlder}
              onClick={() => void store.loadOlder(taskId)}
            >
              {state.loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
            </Button>
          ) : null}
          {state.loading ? <p role="status">Loading conversation…</p> : null}
          {!state.loading && !messages.length ? (
            <div className="sym-simon-empty">
              <p>
                {taskId
                  ? "Ask Simon about this task. He reads the page one section at a time and can update it for you."
                  : "Your workspace helper. Ask a question or turn an idea into a task."}
              </p>
              {taskId ? (
                <Button
                  size="sm"
                  onClick={() =>
                    store.draft(taskId, "Help me decide what to do first for this task.")
                  }
                >
                  What should I do first?
                </Button>
              ) : null}
            </div>
          ) : null}
          {messages.map((message) => (
            <Message key={message.id} from={message.role}>
              <span className="sr-only">{message.role === "user" ? "You" : "Simon"}</span>
              <MessageContent>
                {message.role === "user" ? (
                  <p className="whitespace-pre-wrap">{message.text}</p>
                ) : (
                  <>
                    <MessageResponse>{message.text}</MessageResponse>
                    {message.parts
                      .filter((part) => part.type !== "text")
                      .map((part, index) => (
                        <Activity
                          key={
                            part.type === "tool"
                              ? part.toolCallId
                              : `${message.id}-${part.type}-${index}`
                          }
                          part={part}
                        />
                      ))}
                  </>
                )}
              </MessageContent>
              {message.status === "queued" ? (
                <p className="sym-simon-note">Queued · runs when the current work finishes</p>
              ) : null}
              {message.status === "cancelled" ? (
                <p className="sym-simon-note">Not sent · cancelled</p>
              ) : null}
            </Message>
          ))}
          {run && !state.projection.live?.ended ? (
            <p role="status" className="sym-simon-note">
              {run.status === "awaiting_approval"
                ? "Waiting for your review"
                : run.status === "awaiting_user"
                  ? "Waiting for your answer"
                  : run.status === "queued"
                    ? "Message accepted · waiting to start"
                    : "Simon is working…"}
            </p>
          ) : null}
          {state.approval ? (
            <ApprovalCard key={state.approval.id} state={state} store={store} />
          ) : null}
          {state.ask ? (
            <section className="sym-simon-question" aria-label="Simon has a question">
              <h3>A question for you</h3>
              <MessageResponse>{state.ask.question}</MessageResponse>
              <p>Reply in the composer below.</p>
              <Button
                disabled={disabled}
                onClick={() => {
                  const ask = state.ask;
                  if (ask) void store.command(taskId, (key) => store.api.dismiss(ask.id, key));
                }}
              >
                Skip question
              </Button>
            </section>
          ) : null}
          {terminal?.status === "stopped" ? (
            <p role="status">
              Stopped. The reply above is preserved; completed actions were not undone.
            </p>
          ) : null}
          {terminal?.status === "interrupted" || terminal?.status === "failed" ? (
            <div className="sym-simon-interrupted">
              <p role="status">
                {terminal.outcomeCode === "ai.unavailable"
                  ? "Simon is not configured on this server yet. Your history is still available."
                  : "Simon’s run was interrupted. You can continue from the saved history; uncertain external actions are not repeated automatically."}
              </p>
              {terminal.outcomeCode !== "ai.unavailable" ? (
                <Button
                  disabled={disabled}
                  onClick={() =>
                    void store.command(taskId, (key) => store.api.retry(terminal.runId, key))
                  }
                >
                  Retry interrupted run
                </Button>
              ) : null}
            </div>
          ) : null}
          {state.error ? (
            <InlineError
              title="Could not complete this request"
              description={state.error}
              onRetry={async () => {
                if (state.uncertain) await store.retryRequest(taskId);
                else await store.load(taskId);
              }}
              retryLabel={state.uncertain ? "Retry same request" : "Reload conversation"}
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <form
        className="sym-simon-composer"
        data-action-context="composer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <label className="sr-only" htmlFor={`simon-compose-${taskId ?? "quick"}`}>
          {state.ask ? "Answer Simon’s question" : "Message Simon"}
        </label>
        <textarea
          id={`simon-compose-${taskId ?? "quick"}`}
          value={state.draft}
          placeholder={state.ask ? "Your answer…" : "Ask Simon…"}
          maxLength={32000}
          rows={2}
          disabled={state.busy || state.uncertain}
          onChange={(event) => store.draft(taskId, event.target.value)}
          onKeyDown={(event) => {
            // Enter sends and Shift+Enter writes a new line, as a chat composer is expected to
            // behave. This belongs to the textarea rather than a binding: the dispatcher ignores
            // every unmodified key while someone is typing (note 13), so `enter` in the registry
            // would never fire here. `simon.send_message` keeps its own binding for the palette and
            // for anyone who remapped it. IME composition must finish first, or Enter picking a
            // candidate would send the half-typed line.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            event.preventDefault();
            if (canSendChat(state)) send();
          }}
        />
        <div className="sym-simon-composer-controls">
          <label className="sym-simon-tier">
            Next run
            <select
              aria-label="Simon’s model for the next run"
              value={state.tier}
              disabled={state.busy || state.uncertain}
              onChange={(event) =>
                store.tier(taskId, event.target.value === "smart" ? "smart" : "fast")
              }
            >
              <option value="fast">Fast</option>
              <option value="smart">Smart</option>
            </select>
          </label>
          <span className="flex-1" />
          {run ? (
            <Button type="button" disabled={disabled || run.stopRequested} onClick={stop}>
              <SquareIcon size={12} aria-hidden="true" />
              {run.stopRequested ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="icon"
            type="submit"
            disabled={!canSendChat(state)}
            aria-label={state.ask ? "Send answer" : run ? "Queue message" : "Send message"}
          >
            <ArrowUpIcon size={16} aria-hidden="true" />
          </Button>
        </div>
        <p className="sym-simon-note">
          {state.ask
            ? "Answers this question only."
            : run
              ? "New messages are queued, not immediate steering."
              : "Enter to send, Shift+Enter for a new line."}
        </p>
      </form>
    </div>
  );
}
