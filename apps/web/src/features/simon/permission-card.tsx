"use client";
import type { AcpPermissionRequest } from "@symplist/contracts";
import { ShieldAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatToolCall } from "./projection.ts";
import { argumentSummary, commandOf, toolLabel } from "./tool-labels.ts";

/**
 * The one place a person is asked to authorise something.
 *
 * Approvals come from ACP `session/request_permission` and nowhere else. The cloud's approval card is
 * gone with the connector actions it gated (note 18), and Symplist's own MCP writes are not gated here:
 * the grant the desktop holds is already scoped to the tasks it may touch, and a gate in this process
 * could not stop the harness's own tools anyway — `tools/pre-execute` is a waterfall *inside* dsh, so an
 * out-of-process client cannot intercept a call without shipping a dsh plugin.
 *
 * Two rules the card must not break:
 *
 * - **One button per offered option, in the order offered, labelled by `option.name`.** The harness
 *   offers exactly allow-once and reject-once. An "always" button would tell the person their answer is
 *   remembered when it is not, and no amount of convenience is worth that.
 * - **Say what is being approved.** `dsh-acp` sends `toolCall: { toolCallId }` and nothing else, so the
 *   description has to be joined from the tool call already on screen. When it has not arrived yet the
 *   card says so plainly instead of inventing a subject.
 */
const decisiveKinds = new Set(["allow_once", "allow_always"]);

export function PermissionCard({
  request,
  subject,
  busy,
  onAnswer,
}: {
  readonly request: AcpPermissionRequest;
  /** The tool call the request names, joined by id, or null when it has not been announced. */
  readonly subject: ChatToolCall | null;
  readonly busy: boolean;
  readonly onAnswer: (optionId: string) => void;
}) {
  const name = subject?.name ?? request.toolCall.title ?? null;
  const label = name ? toolLabel(name).label : null;
  const rawInput = subject?.rawInput ?? request.toolCall.rawInput;
  const command = commandOf(rawInput);
  const detail = command ?? (name ? argumentSummary(name, rawInput) : null);
  return (
    <section
      aria-labelledby={`permission-${request.requestId}`}
      className="flex min-w-0 flex-col gap-2.5 rounded-sym-lg border border-sym-line-strong bg-sym-panel p-3"
    >
      <h3
        id={`permission-${request.requestId}`}
        className="m-0 flex items-center gap-2 font-heading font-semibold text-[13.5px]"
      >
        <ShieldAlertIcon
          size={14}
          strokeWidth={2.2}
          aria-hidden="true"
          className="text-sym-accent"
        />
        Simon needs your permission
      </h3>
      {label ? (
        <p className="m-0 text-[13px] text-sym-text">{label} on this machine.</p>
      ) : (
        // No guess: the harness asked about a tool call it has not described yet, and saying so is more
        // use than a confident sentence about the wrong thing.
        <p className="m-0 text-[13px] text-sym-text">
          Simon is asking to run a step it has not described yet.
        </p>
      )}
      {command ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] text-sym-muted uppercase tracking-[0.04em]">Command</span>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-words rounded-sym bg-sym-surface px-2 py-1.5 font-mono text-[12px] text-sym-text">
            {command}
          </pre>
        </div>
      ) : detail ? (
        <p className="m-0 truncate font-mono text-[12px] text-sym-muted">{detail}</p>
      ) : null}
      {subject?.locations.length ? (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {subject.locations.map((location) => (
            <li key={location.path} className="truncate font-mono text-[11.5px] text-sym-muted">
              {location.path}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {request.options.map((option) => (
          <Button
            key={option.optionId}
            size="sm"
            variant={decisiveKinds.has(option.kind) ? "primary" : "secondary"}
            disabled={busy}
            onClick={() => onAnswer(option.optionId)}
          >
            {option.name}
          </Button>
        ))}
      </div>
      <p className="m-0 text-[11.5px] text-sym-muted">
        {/* Stated because the alternative is a person who thinks they have set a preference. */}
        This answer covers this one step. Simon asks again next time.
      </p>
    </section>
  );
}
