"use client";
import { useId, useRef, useState } from "react";
import { vaultMessage } from "./api";

export function SecretField({
  label,
  value,
  onChange,
  autoComplete = "off",
  inputRef,
  errorId,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  errorId?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const id = useId();
  return (
    <div className="vault-field">
      <label htmlFor={id}>{label}</label>
      <div className="vault-secret-input">
        <input
          ref={inputRef}
          id={id}
          type={revealed ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          maxLength={1024}
          aria-invalid={Boolean(errorId)}
          aria-describedby={errorId}
        />
        <button
          type="button"
          aria-label={`${revealed ? "Hide" : "Show"} ${label.toLowerCase()}`}
          aria-pressed={revealed}
          onClick={() => setRevealed(!revealed)}
        >
          {revealed ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}
export function VaultKeyForm({
  mode,
  minimum = 12,
  onSubmit,
  onBack,
  onForgot,
}: {
  mode: "setup" | "unlock" | "reset";
  minimum?: number;
  onSubmit: (passphrase: string, confirmation: string, key: string) => Promise<void>;
  onBack?: () => void;
  onForgot?: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const change = (setter: (value: string) => void) => (value: string) => {
    key.current = null;
    setter(value);
    setError("");
  };
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (mode !== "unlock" && passphrase !== confirmation) {
      setError("The keys do not match.");
      return;
    }
    if (mode !== "unlock" && passphrase.normalize("NFKC").length < minimum) {
      setError(`Use at least ${minimum} characters. A memorable phrase works well.`);
      return;
    }
    setBusy(true);
    key.current ??= crypto.randomUUID();
    try {
      await onSubmit(passphrase, confirmation, key.current);
      setPassphrase("");
      setConfirmation("");
    } catch (error) {
      setError(vaultMessage(error));
      input.current?.focus();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="vault-key-form" onSubmit={submit} aria-busy={busy}>
      <SecretField
        label={
          mode === "unlock"
            ? "Vault key"
            : mode === "reset"
              ? "New vault key"
              : "Create a vault key"
        }
        value={passphrase}
        onChange={change(setPassphrase)}
        inputRef={input}
        {...(error ? { errorId } : {})}
        autoComplete={mode === "unlock" ? "current-password" : "new-password"}
      />
      {mode !== "unlock" && (
        <>
          <SecretField
            label="Confirm vault key"
            value={confirmation}
            onChange={change(setConfirmation)}
            autoComplete="new-password"
          />
          <p className="vault-muted">
            At least {minimum} characters. A memorable phrase works well.
          </p>
        </>
      )}
      {error && (
        <p id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="vault-actions">
        <button className="vault-primary" disabled={busy || !passphrase} type="submit">
          {busy
            ? mode === "unlock"
              ? "Unlocking…"
              : "Saving…"
            : mode === "setup"
              ? "Create vault"
              : mode === "reset"
                ? "Reset vault key"
                : "Unlock"}
        </button>
        {onBack && (
          <button type="button" onClick={onBack} disabled={busy}>
            Back
          </button>
        )}
        {onForgot && (
          <button type="button" onClick={onForgot} disabled={busy}>
            Forgot key?
          </button>
        )}
      </div>
    </form>
  );
}
