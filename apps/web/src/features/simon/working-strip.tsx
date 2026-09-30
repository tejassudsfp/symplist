"use client";
import { Spinner } from "@/components/ui/spinner";
import type { ChatProjection } from "./projection.ts";
import { workingLine } from "./projection.ts";
import { toolLabel } from "./tool-labels.ts";

/**
 * What the pane shows while a turn is running.
 *
 * This replaces the cloud chat's typewriter, and it is a genuine downgrade worth naming rather than
 * hiding: there is no token streaming over ACP. `dsh-acp` converts one *committed* `assistant/message`
 * at a time, so the assistant's reply lands whole and a long turn has nothing to animate except the tool
 * lifecycle and the occasional line of reasoning. If this strip is not informative the app feels broken,
 * and the fix is not available on this side of the protocol boundary.
 *
 * So it says the most specific true thing it can, in this order: the tool still running, the last line
 * the agent thought, or "Thinking" — and never a fabricated stage name.
 */
export function WorkingStrip({
  projection,
  stopping,
}: {
  readonly projection: ChatProjection;
  readonly stopping: boolean;
}) {
  const line = workingLine(projection);
  const text = stopping
    ? "Stopping…"
    : line?.kind === "tool"
      ? `${toolLabel(line.text).label}…`
      : (line?.text ?? "Thinking…");
  return (
    <p
      role="status"
      aria-live="polite"
      data-working-strip=""
      className="m-0 flex min-w-0 items-center gap-2 text-[12.5px] text-sym-muted"
    >
      <Spinner />
      <span className="min-w-0 truncate">{text}</span>
    </p>
  );
}
