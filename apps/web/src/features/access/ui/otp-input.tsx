"use client";

import { cn } from "cn";
import {
  type ChangeEvent,
  forwardRef,
  type ReactNode,
  useCallback,
  useId,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

/** Keeps the digits of typed, pasted or autofilled text, up to the code length. */
export function sanitizeCode(input: string, length: number): string {
  return input.replace(/\D/g, "").slice(0, length);
}

export interface OtpInputProps {
  /** The configured code length (`codeLength` from the send response, 6 by default). */
  readonly length: number;
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Called once the code reaches its full length by typing, paste or autofill. */
  readonly onComplete?: (value: string) => void;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
  readonly name?: string;
}

export interface OtpInputHandle {
  focus(): void;
}

/**
 * The verification code field (email_otp.md): one real `<input>` with `autocomplete="one-time-code"`
 * and a numeric keyboard, so paste, autofill, keyboard editing and screen readers all work on the
 * native control. The cells behind it only draw the digits and the caret position; they are hidden
 * from assistive technology.
 */
export const OtpInput = forwardRef<OtpInputHandle, OtpInputProps>(function OtpInput(
  { length, value, onChange, onComplete, label, description, error, disabled, autoFocus, name },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(value.length);
  const id = useId();
  const inputId = `otp-${id}`;
  const descriptionId = description ? `${inputId}-description` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const syncCaret = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    setCaret(input.selectionStart ?? input.value.length);
  }, []);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = sanitizeCode(event.target.value, length);
    onChange(next);
    setCaret(Math.min(event.target.selectionStart ?? next.length, next.length));
    // Only when the code has just reached its length. Typing into an already-full field inserts a
    // digit and drops the last one, so reporting that as a completion would submit a code the person
    // never meant to send and spend one of the challenge's attempts.
    if (next.length === length && value.length < length) onComplete?.(next);
  };

  const activeIndex = Math.min(caret, length - 1);

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className="font-medium text-[13px] text-sym-text">
        {label}
      </label>
      <div className="relative" data-slot="otp-field">
        <div aria-hidden="true" className="pointer-events-none flex gap-1.5 sm:gap-2">
          {Array.from({ length }, (_, index) => {
            const digit = value[index] ?? "";
            const active = focused && index === activeIndex && !disabled;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: cells are positions, not items.
                key={index}
                data-active={active || undefined}
                data-filled={digit ? true : undefined}
                className={cn(
                  "flex h-12 min-w-0 flex-1 items-center justify-center rounded-sym border bg-sym-surface font-mono text-[22px] text-sym-text tabular-nums transition-[border-color,box-shadow]",
                  error ? "border-sym-danger" : "border-sym-line-strong",
                  active && "border-sym-accent shadow-[0_0_0_3px_var(--sym-accent-soft)]",
                  disabled && "opacity-60",
                )}
              >
                {digit}
              </div>
            );
          })}
        </div>
        <input
          ref={inputRef}
          id={inputId}
          name={name}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern={`[0-9]{${length}}`}
          maxLength={length + 16}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          // biome-ignore lint/a11y/noAutofocus: the code is the only task on this screen, and focus lands here after the code was sent.
          autoFocus={autoFocus}
          disabled={disabled}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={[errorId, descriptionId].filter(Boolean).join(" ") || undefined}
          onChange={handleChange}
          onSelect={syncCaret}
          onKeyUp={syncCaret}
          onFocus={() => {
            setFocused(true);
            syncCaret();
          }}
          onBlur={() => setFocused(false)}
          className="absolute inset-0 h-full w-full cursor-text rounded-sym border-0 bg-transparent text-transparent caret-transparent outline-none selection:bg-transparent"
        />
      </div>
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
