import { Fragment, type ReactNode } from "react";
import type { BindingLabel } from "@/actions/keys";
import { cn } from "@/lib/utils";

/*
 * Platform-aware key caps (note 13, keyboard_shortcuts.md): Command on macOS, Control elsewhere, and
 * a sequence (`g`, then `c`) shown differently from a simultaneous chord. The caps are decorative;
 * the accessible name is the spoken form, so screen readers never read raw event codes.
 */

export interface KeycapsProps {
  readonly label: BindingLabel;
  readonly className?: string;
}

export function Keycaps({ label, className }: KeycapsProps): ReactNode {
  const isSequence = label.steps.length > 1;
  return (
    <span
      className={cn("inline-flex flex-none items-center gap-1", className)}
      data-slot="keycaps"
      data-binding={isSequence ? "sequence" : "chord"}
    >
      <span className="sr-only">{label.spoken}</span>
      {label.steps.map((caps, stepIndex) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps are positional and never reorder.
        <Fragment key={stepIndex}>
          {stepIndex > 0 ? (
            <span aria-hidden="true" className="text-[11px] text-sym-muted">
              then
            </span>
          ) : null}
          <span aria-hidden="true" className="inline-flex items-center gap-[2px]">
            {caps.map((cap, capIndex) => (
              <kbd
                // biome-ignore lint/suspicious/noArrayIndexKey: caps are positional and never reorder.
                key={capIndex}
                className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-sym-line bg-sym-surface px-1 font-mono text-[11px] text-sym-muted leading-none"
              >
                {cap.label}
              </kbd>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** The text form of a binding, for a compact hint line. */
export function bindingText(label: BindingLabel): string {
  return label.display;
}
