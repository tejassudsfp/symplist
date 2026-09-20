"use client";
import type { VaultItem, VaultItemsResponse, VaultStatus } from "@symplist/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { SafeMarkdown } from "@/components/markdown/safe-markdown";
import { ConfirmDialog } from "@/components/ui/dialog";
import { useSession } from "@/features/access/session";
import { RealtimeClient, realtimeUrl } from "@/lib/realtime";
import { getVaultApi, type VaultApi, vaultIsLocked, vaultMessage } from "./api";
import { VaultItemEditor } from "./item-editor";
import { VaultKeyForm } from "./key-form";
import { VaultResetScreen } from "./reset-screen";

type Screen = "loading" | "error" | "setup" | "unlock" | "items" | "reset";
export function VaultScreen({
  initial = "home",
  itemId,
  addItem = false,
  api: provided,
}: {
  initial?: "home" | "setup" | "unlock" | "reset";
  itemId?: string;
  addItem?: boolean;
  api?: VaultApi;
}) {
  const [api] = useState(() => provided ?? getVaultApi());
  const session = useSession();
  const [screen, setScreen] = useState<Screen>("loading");
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [page, setPage] = useState<VaultItemsResponse | null>(null);
  const [selected, setSelected] = useState<VaultItem | null>(null);
  const [detailTarget, setDetailTarget] = useState<string | null>(null);
  const [editor, setEditor] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const epoch = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);
  const detail = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const expiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const deleteKey = useRef<string | null>(null);
  const lastTouch = useRef(0);
  const clear = useCallback((message = "Your vault locked. Any unsaved draft was discarded.") => {
    epoch.current++;
    setPage(null);
    setSelected(null);
    setDetailTarget(null);
    setEditor(false);
    setRevealed(false);
    setQuery("");
    setDeleteOpen(false);
    setBusy(false);
    setScreen("unlock");
    setNotice(message);
    setError("");
    if (expiry.current) clearTimeout(expiry.current);
  }, []);
  const arm = useCallback(
    (until: number) => {
      if (expiry.current) clearTimeout(expiry.current);
      expiry.current = setTimeout(
        () => {
          clear();
          void api.lock().catch(() => undefined);
        },
        Math.max(0, until - Date.now()),
      );
    },
    [api, clear],
  );
  const openItem = useCallback(
    async (id: string) => {
      const request = ++epoch.current;
      setBusy(true);
      setError("");
      setRevealed(false);
      setSelected(null);
      setDetailTarget(id);
      try {
        const item = await api.read(id);
        if (request === epoch.current) {
          setSelected(item);
          setEditor(false);
        }
      } catch (e) {
        if (request !== epoch.current) return;
        if (vaultIsLocked(e)) clear();
        else setError(vaultMessage(e));
      } finally {
        if (request === epoch.current) setBusy(false);
      }
    },
    [api, clear],
  );
  const load = useCallback(async () => {
    const request = ++epoch.current;
    setError("");
    try {
      const state = await api.status();
      if (request !== epoch.current) return;
      setStatus(state);
      if (state.state === "unlocked") {
        const result = await api.list();
        if (request !== epoch.current) return;
        setPage(result);
        setScreen("items");
        setEditor(addItem);
        setDetailTarget(itemId ?? null);
        arm(result.idleExpiresAt);
        if (itemId) await openItem(itemId);
      } else {
        setPage(null);
        setSelected(null);
        setDetailTarget(null);
        setScreen(
          state.state === "not_created" ? "setup" : initial === "reset" ? "reset" : "unlock",
        );
      }
    } catch (e) {
      if (request !== epoch.current) return;
      setError(vaultMessage(e));
      setScreen("error");
    }
  }, [api, arm, initial, itemId, openItem, addItem]);
  useEffect(() => {
    void load();
    return () => {
      epoch.current++;
      if (expiry.current) clearTimeout(expiry.current);
    };
  }, [load]);
  useEffect(() => {
    if (screen !== "loading") title.current?.focus();
  }, [screen]);
  useEffect(() => {
    if (selected?.id || editor || detailTarget) detail.current?.focus();
  }, [selected?.id, editor, detailTarget]);
  useEffect(() => {
    const url = realtimeUrl();
    if (!url) return;
    const client = new RealtimeClient({ url });
    const unsubscribe = client.subscribeUser([], {
      onEvent: (frame) => {
        if (frame.type === "vault.locked")
          clear("Your vault was locked. Unlock again to continue.");
      },
    });
    client.connect();
    return () => {
      unsubscribe.unsubscribe();
      client.disconnect();
    };
  }, [clear]);
  useEffect(() => {
    if (screen !== "items") return;
    const hide = () => {
      if (document.visibilityState === "hidden") {
        clear("Your vault locked when you left this screen. Unsaved drafts were discarded.");
        void api.lock().catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", hide);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", hide);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [screen, api, clear]);
  async function touch() {
    if (screen !== "items" || Date.now() - lastTouch.current < 60000) return;
    lastTouch.current = Date.now();
    const request = epoch.current;
    try {
      const state = await api.touch();
      if (request === epoch.current) arm(state.idleExpiresAt);
    } catch (e) {
      if (request === epoch.current && vaultIsLocked(e)) clear();
    }
  }
  async function afterSave(id: string, request: number) {
    if (request !== epoch.current) return;
    setEditor(false);
    setNotice("Saved");
    const result = await api.list();
    if (request !== epoch.current) return;
    setPage(result);
    arm(result.idleExpiresAt);
    await openItem(id);
  }
  async function lock() {
    clear("Your vault is locked.");
    try {
      await api.lock();
    } catch {
      setNotice(
        "This screen is cleared. Couldn’t reach the server; the session will expire automatically.",
      );
    }
  }
  async function remove() {
    if (!selected || busy) return;
    setBusy(true);
    const request = epoch.current;
    deleteKey.current ??= crypto.randomUUID();
    try {
      await api.remove(selected.id, selected.version, deleteKey.current);
      if (request !== epoch.current) return;
      deleteKey.current = null;
      setDeleteOpen(false);
      setSelected(null);
      setDetailTarget(null);
      setNotice("Item deleted");
      const next = await api.list();
      if (request === epoch.current) setPage(next);
    } catch (e) {
      if (request !== epoch.current) return;
      if (vaultIsLocked(e)) clear();
      else setError(vaultMessage(e));
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  const minimum = status?.minimumKeyLength ?? 12;
  const renderedEpoch = epoch.current;
  const filtered =
    page?.items.filter((item) =>
      item.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    ) ?? [];
  const hasDetail = Boolean(selected || editor || detailTarget);
  return (
    <main
      className="vault-screen"
      onPointerDown={() => void touch()}
      onKeyDown={() => void touch()}
    >
      <header className="vault-topbar">
        <a href="/now" className="vault-wordmark">
          symplist
        </a>
        <h1 ref={title} tabIndex={-1}>
          Vault
        </h1>
        <a href="/now">Back to tasks</a>
        {screen === "items" && (
          <button type="button" onClick={() => void lock()}>
            Lock vault
          </button>
        )}
      </header>
      {notice && (
        <p role="status" className="vault-notice">
          {notice}
        </p>
      )}
      {screen === "loading" && (
        <p className="vault-loading" role="status">
          Opening Vault…
        </p>
      )}
      {screen === "error" && (
        <section className="vault-card">
          <p role="alert">{error}</p>
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </section>
      )}
      {screen === "setup" && (
        <section className="vault-card">
          <h2>Keep sensitive notes and keys here.</h2>
          <p>Create a vault key separate from your email login.</p>
          <VaultKeyForm
            mode="setup"
            minimum={minimum}
            onSubmit={async (pass, confirmation, key) => {
              await api.setup(pass, confirmation, key);
              await load();
            }}
          />
          <details>
            <summary>How recovery works</summary>
            <p>
              The service supports recovery through fresh email verification, preserving your vault
              contents if you forget your key.
            </p>
          </details>
          <button type="button" onClick={() => void load()}>
            Unlock existing vault
          </button>
        </section>
      )}
      {screen === "unlock" && (
        <section className="vault-card">
          <h2>Unlock your vault</h2>
          <p className="vault-muted">Your vault key is separate from email login.</p>
          <VaultKeyForm
            mode="unlock"
            onForgot={() => {
              setNotice("");
              setScreen("reset");
            }}
            onSubmit={async (pass, _confirmation, key) => {
              await api.unlock(pass, key);
              setNotice("");
              await load();
            }}
          />
        </section>
      )}
      {screen === "reset" && (
        <VaultResetScreen
          api={api}
          {...(session.user?.email ? { email: session.user.email } : {})}
          minimum={minimum}
          onBack={() => setScreen("unlock")}
          onSuccess={() => {
            clear(
              "Your vault key was updated. Unlock with your new key. Other vault sessions need to unlock again.",
            );
          }}
        />
      )}
      {screen === "items" && (
        <div className={`vault-workspace ${hasDetail ? "vault-has-detail" : ""}`}>
          <aside className="vault-list">
            <header>
              <label className="vault-field">
                Search vault
                <input
                  ref={search}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find an item…"
                />
              </label>
              {page?.nextCursor && (
                <p className="vault-muted">
                  Search covers loaded items. Load more to include the rest.
                </p>
              )}
              <button
                type="button"
                className="vault-primary"
                disabled={editor}
                onClick={() => {
                  setSelected(null);
                  setDetailTarget(null);
                  setEditor(true);
                  setError("");
                }}
              >
                Add item
              </button>
            </header>
            {filtered.length === 0 ? (
              <p className="vault-muted">
                {query ? "No matching items." : "Nothing here yet. Add a secret or secure note."}
              </p>
            ) : (
              <ul>
                {filtered.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={editor}
                      aria-current={selected?.id === item.id ? "true" : undefined}
                      onClick={() => void openItem(item.id)}
                    >
                      <span>{item.title}</span>
                      <small>{item.type === "secret" ? "Secret" : "Secure note"}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {page?.nextCursor && (
              <button
                type="button"
                disabled={busy || editor}
                onClick={async () => {
                  const request = epoch.current;
                  setBusy(true);
                  try {
                    const next = await api.list(page.nextCursor ?? undefined);
                    if (request !== epoch.current) return;
                    setPage((current) =>
                      current ? { ...next, items: [...current.items, ...next.items] } : next,
                    );
                    arm(next.idleExpiresAt);
                  } catch (e) {
                    if (request !== epoch.current) return;
                    if (vaultIsLocked(e)) clear();
                    else setError(vaultMessage(e));
                  } finally {
                    if (request === epoch.current) setBusy(false);
                  }
                }}
              >
                Load more
              </button>
            )}
            {error && !hasDetail ? <p role="alert">{error}</p> : null}
          </aside>
          <section
            className="vault-detail"
            ref={detail}
            tabIndex={-1}
            aria-label="Vault item detail"
          >
            <button
              type="button"
              className="vault-back-list"
              hidden={editor}
              onClick={() => {
                setSelected(null);
                setDetailTarget(null);
                setEditor(false);
                setError("");
                search.current?.focus();
              }}
            >
              Back to items
            </button>
            {error && hasDetail ? <p role="alert">{error}</p> : null}
            {busy && detailTarget && !selected && !editor ? (
              <p role="status">Loading item…</p>
            ) : null}
            {editor ? (
              <VaultItemEditor
                key={selected?.id ?? "new"}
                item={selected}
                api={api}
                onSaved={(id) => afterSave(id, renderedEpoch)}
                onCancel={() => setEditor(false)}
                onLock={() => clear()}
              />
            ) : selected ? (
              <>
                <header>
                  <h2>{selected.title}</h2>
                  <span className="vault-muted">
                    {selected.type === "secret" ? "Secret" : "Secure note"}
                  </span>
                </header>
                {selected.type === "secret" ? (
                  <div className="vault-value">
                    <output aria-label={revealed ? "Revealed secret" : "Hidden secret"}>
                      {revealed ? selected.value : "••••••••••••••••"}
                    </output>
                    <button
                      type="button"
                      onClick={() => setRevealed(!revealed)}
                      aria-pressed={revealed}
                    >
                      {revealed ? "Hide secret" : "Reveal secret"}
                    </button>
                  </div>
                ) : (
                  <SafeMarkdown source={selected.value} />
                )}
                <div className="vault-actions">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(selected.value);
                        setNotice(
                          "Copied to clipboard. Clipboard contents are managed by your device.",
                        );
                      } catch {
                        setNotice(
                          "Couldn’t copy. Reveal and select the value to copy it manually.",
                        );
                      }
                    }}
                  >
                    Copy
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRevealed(false);
                      setEditor(true);
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" onClick={() => setDeleteOpen(true)}>
                    Delete
                  </button>
                </div>
              </>
            ) : (
              !busy && (
                <p className="vault-muted">
                  Select an item to view it. Secrets stay hidden until you reveal them.
                </p>
              )
            )}
          </section>
        </div>
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this item?"
        description={
          selected
            ? `Delete “${selected.title}” from your vault? Its task grants will also be revoked.`
            : ""
        }
        confirmLabel="Delete item"
        initialFocus="cancel"
        busy={busy}
        onConfirm={() => void remove()}
      />
    </main>
  );
}
