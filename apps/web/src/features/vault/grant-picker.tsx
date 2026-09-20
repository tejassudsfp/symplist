"use client";
import type { VaultGrantRequest, VaultItemsResponse } from "@symplist/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeClient, realtimeUrl } from "@/lib/realtime";
import { getVaultApi, type VaultApi, vaultIsLocked, vaultMessage } from "./api";
import { VaultKeyForm } from "./key-form";

/** Trusted approval-UI seam: context is explicit; a chat message never creates this grant. */
export function VaultGrantPicker({
  context,
  onGranted,
  onCancel,
  api: provided,
}: {
  context: Pick<VaultGrantRequest, "taskId" | "conversationId" | "toolSlug" | "argumentPath">;
  onGranted: (handle: { $vault: string }) => void;
  onCancel: () => void;
  api?: VaultApi;
}) {
  const [api] = useState(() => provided ?? getVaultApi());
  const [items, setItems] = useState<VaultItemsResponse | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  const expires = useRef<number | null>(null);
  const epoch = useRef(0);
  const contextKey = JSON.stringify(context);
  const clear = useCallback(() => {
    epoch.current++;
    setItems(null);
    setSelected("");
    setLocked(true);
    setBusy(false);
    key.current = null;
    expires.current = null;
  }, []);
  const load = useCallback(async () => {
    const request = epoch.current;
    setError("");
    try {
      const result = await api.list();
      if (request !== epoch.current) return;
      setItems(result);
      setLocked(false);
    } catch (e) {
      if (request !== epoch.current) return;
      if (vaultIsLocked(e)) clear();
      setError(vaultMessage(e));
    }
  }, [api, clear]);
  useEffect(() => {
    if (!contextKey) return;
    epoch.current++;
    setItems(null);
    setSelected("");
    key.current = null;
    expires.current = null;
    void load();
    return () => {
      epoch.current++;
    };
  }, [load, contextKey]);
  useEffect(() => {
    if (!items) return;
    const lock = () => {
      clear();
      void api.lock().catch(() => undefined);
    };
    const timer = setTimeout(lock, Math.max(0, items.idleExpiresAt - Date.now()));
    const hide = () => {
      if (document.visibilityState === "hidden") lock();
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [items, clear, api]);
  useEffect(() => {
    const url = realtimeUrl();
    if (!url) return;
    const client = new RealtimeClient({ url });
    const subscription = client.subscribeUser([], {
      onEvent: (frame) => {
        if (frame.type === "vault.locked") clear();
      },
    });
    client.connect();
    return () => {
      subscription.unsubscribe();
      client.disconnect();
    };
  }, [clear]);
  async function more() {
    if (!items?.nextCursor || busy) return;
    const request = epoch.current;
    setBusy(true);
    try {
      const result = await api.list(items.nextCursor);
      if (request === epoch.current)
        setItems({ ...result, items: [...items.items, ...result.items] });
    } catch (e) {
      if (request !== epoch.current) return;
      if (vaultIsLocked(e)) clear();
      setError(vaultMessage(e));
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  async function grant() {
    const item = items?.items.find((item) => item.id === selected);
    if (!item || busy) return;
    setBusy(true);
    const request = epoch.current;
    key.current ??= crypto.randomUUID();
    expires.current ??= Date.now() + 3600000;
    try {
      const result = await api.grant(
        { ...context, itemId: item.id, itemVersion: item.version, expiresAt: expires.current },
        key.current,
      );
      if (request === epoch.current) onGranted(result.handle);
    } catch (e) {
      if (request !== epoch.current) return;
      if (vaultIsLocked(e)) clear();
      setError(vaultMessage(e));
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  return (
    <section className="vault-grant-picker">
      <h3>Use a vault item</h3>
      <p>
        Allow one item for this task’s {context.toolSlug} action, at {context.argumentPath}, for one
        hour. Simon receives a handle, not the value.
      </p>
      {locked ? (
        <>
          <p>
            Unlock your vault, then select the item deliberately. This does not approve the action.
          </p>
          <VaultKeyForm
            mode="unlock"
            onSubmit={async (passphrase, _confirmation, intent) => {
              const request = epoch.current;
              await api.unlock(passphrase, intent);
              if (request === epoch.current) await load();
            }}
          />
          <a href="/vault/setup">Set up or recover your vault</a>
        </>
      ) : items ? (
        <label className="vault-field">
          Item
          <select
            value={selected}
            disabled={busy}
            onChange={(e) => {
              setSelected(e.target.value);
              key.current = null;
              expires.current = null;
            }}
          >
            <option value="">Choose an item</option>
            {items.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
        </label>
      ) : !error ? (
        <p role="status">Loading vault items…</p>
      ) : (
        <button type="button" onClick={() => void load()}>
          Retry
        </button>
      )}
      {items?.nextCursor && (
        <button type="button" disabled={busy} onClick={() => void more()}>
          Load more items
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="vault-actions">
        <button type="button" disabled={!selected || busy || locked} onClick={() => void grant()}>
          {busy ? "Granting…" : "Use this item"}
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
