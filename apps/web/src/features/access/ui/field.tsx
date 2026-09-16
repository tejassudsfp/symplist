"use client";

import { cn } from "cn";
import { type ComponentProps, forwardRef, type ReactNode, useId } from "react";

/** Input styling from the sample: surface field, strong line, accent ring on focus (workspace_now). */
export const inputClassName =
  "h-10 w-full min-w-0 rounded-sym border border-sym-line-strong bg-sym-surface px-3 text-base text-sym-text outline-none transition-[border-color,box-shadow] placeholder:text-sym-muted focus-visible:border-sym-accent focus-visible:shadow-[0_0_0_3px_var(--sym-accent-soft)] disabled:opacity-60 aria-[invalid=true]:border-sym-danger md:h-9 md:text-[14px]";

export interface TextFieldProps extends Omit<ComponentProps<"input">, "id"> {
  readonly label: ReactNode;
  /** Help text under the field, linked with `aria-describedby`. */
  readonly description?: ReactNode;
  /** A validation message; marks the input invalid and is announced with it. */
  readonly error?: ReactNode;
  readonly id?: string;
  readonly containerClassName?: string;
  /** Visually hides the label while keeping it the accessible name. */
  readonly hideLabel?: boolean;
}

/** A labeled text input with optional help text and an inline validation message. */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, description, error, id, className, containerClassName, hideLabel, ...props },
  ref,
) {
  const generated = useId();
  const inputId = id ?? `field-${generated}`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [errorId, descriptionId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex flex-col gap-1.5", containerClassName)}>
      <label
        htmlFor={inputId}
        className={cn("font-medium text-[13px] text-sym-text", hideLabel && "sr-only")}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cn(inputClassName, className)}
        {...props}
      />
      {error ? (
        <p id={errorId} className="m-0 text-[13px] text-sym-danger">
          {error}
        </p>
      ) : null}
      {description ? (
        <p id={descriptionId} className="m-0 text-[12.5px] text-sym-muted">
          {description}
        </p>
      ) : null}
    </div>
  );
});
