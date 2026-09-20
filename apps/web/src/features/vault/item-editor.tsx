"use client";
import type { VaultItem, VaultItemContent } from "@symplist/contracts";
import { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/dialog";
import { type VaultApi, vaultIsLocked, vaultMessage } from "./api";

export function VaultItemEditor({
  item,
  api,
  onSaved,
  onCancel,
  onLock,
}: {
  item: VaultItem | null;
  api: VaultApi;
  onSaved: (id: string) => Promise<void>;
  onCancel: () => void;
  onLock: () => void;
}) {
  const [type, setType] = useState<VaultItemContent["type"]>(item?.type ?? "secret");
  const [title, setTitle] = useState(item?.title ?? "");
  const [value, setValue] = useState(item?.value ?? "");
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const key = useRef<string | null>(null);
  const dirty =
    title !== (item?.title ?? "") ||
    value !== (item?.value ?? "") ||
    type !== (item?.type ?? "secret");
  function change(work: () => void) {
    key.current = null;
    setError("");
    work();
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!title.trim()) {
      setError("Add a title before saving.");
      return;
    }
    setBusy(true);
    setError("");
    key.current ??= crypto.randomUUID();
    try {
      const result = await api.save(
        { type, title, value },
        key.current,
        item ? { id: item.id, version: item.version } : undefined,
      );
      await onSaved(result.id);
    } catch (e) {
      if (vaultIsLocked(e)) {
        onLock();
        return;
      }
      setError(vaultMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="vault-editor">
      <header>
        <h2>{item ? "Edit item" : "Add item"}</h2>
        <span className="vault-muted">{busy ? "Saving…" : dirty ? "Unsaved" : ""}</span>
      </header>
      <form onSubmit={save} aria-busy={busy}>
        <fieldset disabled={busy}>
          <legend>Item type</legend>
          <label>
            <input
              type="radio"
              name="item-type"
              checked={type === "secret"}
              onChange={() => change(() => setType("secret"))}
            />{" "}
            Secret
          </label>
          <label>
            <input
              type="radio"
              name="item-type"
              checked={type === "note"}
              onChange={() => change(() => setType("note"))}
            />{" "}
            Secure note
          </label>
        </fieldset>
        <label className="vault-field">
          Title
          <input
            value={title}
            maxLength={200}
            onChange={(e) => change(() => setTitle(e.target.value))}
          />
        </label>
        {type === "secret" ? (
          <div className="vault-field">
            <label htmlFor="vault-item-secret-value">Secret value</label>
            <div className="vault-secret-input">
              <input
                id="vault-item-secret-value"
                value={value}
                type={revealed ? "text" : "password"}
                autoComplete="off"
                maxLength={64000}
                onChange={(e) => change(() => setValue(e.target.value))}
              />
              <button
                type="button"
                onClick={() => setRevealed(!revealed)}
                aria-label={revealed ? "Hide secret value" : "Reveal secret value"}
                aria-pressed={revealed}
              >
                {revealed ? "Hide" : "Reveal"}
              </button>
            </div>
          </div>
        ) : (
          <label className="vault-field">
            Secure note
            <textarea
              value={value}
              rows={14}
              maxLength={64000}
              onChange={(e) => change(() => setValue(e.target.value))}
              placeholder="Write a note… Markdown is supported."
            />
          </label>
        )}
        <p className="vault-muted">
          If the vault locks, this unsaved draft is discarded to clear unlocked data.
        </p>
        {item && (
          <p className="vault-muted">
            Saving an edit revokes this item’s task grants. Review and grant the new value
            separately.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="vault-actions">
          <button className="vault-primary" disabled={busy} type="submit">
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => (dirty ? setDiscard(true) : onCancel())}
          >
            Cancel
          </button>
        </div>
      </form>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard this draft?"
        description="Your unsaved changes will be discarded. The saved item stays unchanged."
        confirmLabel="Discard draft"
        initialFocus="cancel"
        onConfirm={onCancel}
      />
    </section>
  );
}
