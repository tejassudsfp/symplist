"use client";
import { acpBlockText } from "@symplist/contracts";
import { cn } from "cn";
import {
  CheckIcon,
  FileTextIcon,
  HistoryIcon,
  ListTodoIcon,
  PencilLineIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { ChatToolCall } from "./projection.ts";
import {
  argumentSummary,
  commandOf,
  isSymplistTool,
  type ToolIcon,
  toolLabel,
} from "./tool-labels.ts";

/**
 * One tool call, as a card.
 *
 * These cards are not decoration — they are the progress bar. `dsh-acp` puts only *committed* assistant
 * messages on the wire and says raw provider deltas "stay off the wire", so there is no token streaming
 * and a forty-second turn would otherwise be a spinner and nothing else. The tool lifecycle is the only
 * thing that moves, which makes "what is it doing right now" a question this component answers.
 *
 * A shell call is the one the whole desktop exists for, so it is the one shown in full: the command as
 * the agent will run it, and its output. The command comes from `rawInput`, which is where the harness
 * puts a tool's parsed arguments verbatim.
 */
const icons: Record<ToolIcon, typeof TerminalIcon> = {
  execute: TerminalIcon,
  edit: PencilLineIcon,
  read: FileTextIcon,
  search: SearchIcon,
  task: ListTodoIcon,
  history: HistoryIcon,
  other: WrenchIcon,
};

/** The text a tool call produced, flattened. Only `content` entries carry any; a diff is shown apart. */
function outputText(call: ChatToolCall): string {
  return call.content
    .map((entry) => (entry.type === "content" ? acpBlockText(entry.content) : ""))
    .filter(Boolean)
    .join("\n")
    .trimEnd();
}

/** The diffs a tool call reported. The harness does not send these today; a later one may. */
function diffs(call: ChatToolCall) {
  return call.content.flatMap((entry) => (entry.type === "diff" ? [entry] : []));
}

/** How the status reads, in words rather than only a colour. */
function statusWord(call: ChatToolCall): string {
  switch (call.status) {
    case "pending":
      return "Queued";
    case "in_progress":
      return "Working";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
  }
}

export function ToolCallCard({ call }: { call: ChatToolCall }) {
  const { label, icon } = toolLabel(call.name);
  const Icon = icons[icon];
  const command = commandOf(call.rawInput);
  const summary = command ?? argumentSummary(call.name, call.rawInput);
  const output = outputText(call);
  const fileDiffs = diffs(call);
  const running = call.status === "pending" || call.status === "in_progress";
  const failed = call.status === "failed";
  return (
    <details
      data-tool={call.name}
      data-status={call.status}
      // A finished call folds away; one that is running or has failed stays open, because those are the
      // two states a person is actually looking for.
      open={running || failed}
      className="min-w-0 rounded-sym border border-sym-line bg-sym-panel text-[12.5px]"
    >
      <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus">
        <Icon
          size={13}
          strokeWidth={2}
          aria-hidden="true"
          className={cn("shrink-0", failed ? "text-sym-danger" : "text-sym-muted")}
        />
        <span className="shrink-0 font-medium text-sym-text">{label}</span>
        {summary ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-sym-muted">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {running ? (
          <Spinner />
        ) : failed ? (
          <XIcon
            size={13}
            strokeWidth={2.4}
            aria-hidden="true"
            className="shrink-0 text-sym-danger"
          />
        ) : (
          <CheckIcon
            size={13}
            strokeWidth={2.4}
            aria-hidden="true"
            className="shrink-0 text-sym-ok"
          />
        )}
        <span className="sr-only">{statusWord(call)}</span>
      </summary>
      <div className="flex min-w-0 flex-col gap-2 border-sym-line border-t px-2.5 py-2">
        {command ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] text-sym-muted uppercase tracking-[0.04em]">Command</span>
            <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-sym bg-sym-surface px-2 py-1.5 font-mono text-[11.5px] text-sym-text">
              {command}
            </pre>
          </div>
        ) : null}
        {isSymplistTool(call.name) && call.locations.length === 0 ? (
          <p className="m-0 text-[11.5px] text-sym-muted">
            Through your Symplist workspace, under the permissions you granted this app.
          </p>
        ) : null}
        {call.locations.length ? (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11px] text-sym-muted uppercase tracking-[0.04em]">Files</span>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {call.locations.map((location) => (
                <li
                  key={`${location.path}:${location.line ?? ""}`}
                  className="truncate font-mono text-[11.5px] text-sym-text"
                >
                  {location.path}
                  {location.line != null ? `:${location.line}` : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {fileDiffs.map((diff) => (
          <div key={diff.path} className="flex min-w-0 flex-col gap-1">
            <span className="truncate font-mono text-[11.5px] text-sym-text">{diff.path}</span>
            {diff.oldText ? (
              <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-sym bg-sym-surface px-2 py-1.5 font-mono text-[11.5px] text-sym-muted line-through">
                {diff.oldText}
              </pre>
            ) : null}
            <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-sym bg-sym-surface px-2 py-1.5 font-mono text-[11.5px] text-sym-text">
              {diff.newText}
            </pre>
          </div>
        ))}
        {output ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-[11px] text-sym-muted uppercase tracking-[0.04em]">
              {failed ? "Error" : "Output"}
            </span>
            {/* A command's output can be enormous, so the card caps its height and scrolls rather than
                pushing the rest of the conversation off the screen. */}
            <pre
              className={cn(
                "m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-sym bg-sym-surface px-2 py-1.5 font-mono text-[11.5px]",
                failed ? "text-sym-danger" : "text-sym-text",
              )}
            >
              {output}
            </pre>
          </div>
        ) : running ? (
          <p className="m-0 text-[11.5px] text-sym-muted">No output yet.</p>
        ) : null}
        {!output && !running && !fileDiffs.length ? (
          <p className="m-0 text-[11.5px] text-sym-muted">
            {failed ? "This step failed and reported nothing." : "Finished with no output."}
          </p>
        ) : null}
      </div>
    </details>
  );
}
