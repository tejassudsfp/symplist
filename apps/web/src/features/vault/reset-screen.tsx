"use client";
import { useEffect, useRef, useState } from "react";
import { type VaultApi, vaultMessage } from "./api";
import { VaultKeyForm } from "./key-form";

export function VaultResetScreen({
  api,
  email,
  minimum,
  onBack,
  onSuccess,
}: {
  api: VaultApi;
  email?: string;
  minimum: number;
  onBack: () => void;
  onSuccess: () => void;
}) {
  const [step, setStep] = useState<"send" | "verify" | "key">("send");
  const [challenge, setChallenge] = useState("");
  const [code, setCode] = useState("");
  const [authorization, setAuthorization] = useState<{
    authorizationId: string;
    expiresAt: number;
  } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step) title.current?.focus();
  }, [step]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  async function send() {
    if (busy || cooldown > 0) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.sendCode();
      setChallenge(result.challengeId);
      setCode("");
      setStep("verify");
      setCooldown(60);
    } catch (e) {
      setError(vaultMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setAuthorization(await api.verify(challenge, code));
      setCode("");
      setStep("key");
    } catch (e) {
      setError(vaultMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="vault-card">
      <h1 ref={title} tabIndex={-1}>
        {step === "verify"
          ? "Verify vault reset"
          : step === "key"
            ? "Choose a new vault key"
            : "Reset your vault key"}
      </h1>
      <p>Your existing vault contents are preserved. A fresh email code authorizes this change.</p>
      {step === "send" && (
        <>
          <p className="vault-muted">
            We’ll send a code to your verified account email{email ? ` (${email})` : ""}. Your
            sign-in code cannot be reused.
          </p>
          <div className="vault-actions">
            <button
              type="button"
              className="vault-primary"
              onClick={() => void send()}
              disabled={busy}
            >
              {busy ? "Sending…" : "Send reset code"}
            </button>
            <button type="button" onClick={onBack}>
              Back to Unlock
            </button>
          </div>
        </>
      )}
      {step === "verify" && (
        <form onSubmit={verify}>
          <p>Enter the code sent to {email ?? "your verified email"}.</p>
          <label className="vault-field">
            Verification code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
            />
          </label>
          <div className="vault-actions">
            <button type="submit" className="vault-primary" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button type="button" onClick={() => void send()} disabled={busy || cooldown > 0}>
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
            <button type="button" onClick={onBack}>
              Cancel
            </button>
          </div>
          <a href="/signin">Use a different account</a>
        </form>
      )}
      {step === "key" && authorization && (
        <>
          <p className="vault-muted">
            Verified for 10 minutes. Other vault sessions will need to unlock again.
          </p>
          <VaultKeyForm
            mode="reset"
            minimum={minimum}
            onBack={() => {
              setAuthorization(null);
              setStep("send");
            }}
            onSubmit={async (passphrase, confirmation, key) => {
              if (Date.now() >= authorization.expiresAt) {
                setAuthorization(null);
                setStep("send");
                setError("Verification expired. Request a fresh code. Your items are unchanged.");
                return;
              }
              await api.reset(authorization.authorizationId, passphrase, confirmation, key);
              setAuthorization(null);
              onSuccess();
            }}
          />
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
