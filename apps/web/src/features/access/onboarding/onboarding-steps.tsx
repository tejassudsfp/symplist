"use client";

import { cn } from "cn";

export type OnboardingStepId = "name" | "connections";

const steps: ReadonlyArray<{ id: OnboardingStepId; label: string }> = [
  { id: "name", label: "Your name" },
  { id: "connections", label: "Connections" },
];

/** The two-step progression of first-run setup (onboarding_name.md); there is no payment step. */
export function OnboardingProgress({ current }: { current: OnboardingStepId }) {
  const index = steps.findIndex((step) => step.id === current);
  return (
    <ol
      className="m-0 flex list-none items-center gap-2 p-0 text-[12.5px] text-sym-muted"
      aria-label={`Step ${index + 1} of ${steps.length}`}
    >
      {steps.map((step, position) => (
        <li key={step.id} className="flex items-center gap-2">
          {position > 0 ? <span aria-hidden="true">→</span> : null}
          <span
            className={cn(
              position === index && "font-medium text-sym-text",
              position < index && "text-sym-muted",
            )}
            {...(position === index ? { "aria-current": "step" as const } : {})}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
