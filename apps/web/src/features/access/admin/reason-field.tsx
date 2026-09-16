"use client";

import { useId } from "react";

/** The longest admin reason the api stores (`adminReasonSchema`). */
export const reasonMaxLength = 500;

/**
 * The reason an administrator must record for an access change (§5.4). It is encrypted under the
 * target account's key and shown in the activity log, so it is written for another operator to read.
 */
export function ReasonField({
  value,
  onChange,
  error,
  disabled,
  label = "Reason",
  description = "Recorded in the activity log and encrypted with the account's own key.",
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  disabled?: boolean;
  label?: string;
  description?: string;
}) {
  const id = useId();
  const fieldId = `reason-${id}`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="font-medium text-[13px] text-sym-text">
        {label}
      </label>
      <textarea
        id={fieldId}
        rows={3}
        maxLength={reasonMaxLength}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={`${fieldId}-description`}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-sym border border-sym-line-strong bg-sym-surface px-3 py-2 text-base text-sym-text outline-none focus-visible:border-sym-accent focus-visible:shadow-[0_0_0_3px_var(--sym-accent-soft)] aria-[invalid=true]:border-sym-danger md:text-[14px]"
      />
      {error ? <p className="m-0 text-[13px] text-sym-danger">{error}</p> : null}
      <p id={`${fieldId}-description`} className="m-0 text-[12.5px] text-sym-muted">
        {description}
      </p>
    </div>
  );
}
