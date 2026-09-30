"use client";

/**
 * The Vault quick-access panel: the 320 px window the desktop shell opens from its menu-bar icon.
 *
 * It is the vault and nothing else. No workspace chrome, no rail, no documents — a passphrase prompt,
 * the item list, and one item at a time. Everything it does goes through the same `/v1/vault` routes
 * `VaultScreen` uses (`features/vault/api.ts`), so there is no second vault implementation to keep
 * correct and no endpoint that exists only for the desktop.
 *
 * It lives in `apps/web` rather than in `apps/desktop` for two reasons that are the same reason. The
 * theme is a `<style>` element the root layout renders from the `sym_appearance` cookie, so a page on
 * this origin inherits whichever of the six themes the person chose, in light or dark, with no second
 * palette to maintain; and `/v1` calls in the desktop app are made by the Electron main process, which
 * holds the session cookie — `getApiClient()` already routes through that bridge, so this panel holds
 * no token for exactly the reason the workspace holds none.
 *
 * What it does ask the shell for is the shell's own business: hide me, put this on the clipboard and
 * take it off again, open the main window, and tell me when I am shown or dismissed. That is the
 * `vaultPanel` bridge, matched structurally here and never imported, because `apps/web` must not
 * depend on `apps/desktop`.
 */

import type { VaultItem, VaultItemsResponse } from "@symplist/contracts";
import { type ReactElement, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { SymplistMark } from "@/components/brand/logo";
import { useSession } from "@/features/access/session";
import { getVaultApi, type VaultApi, vaultIsLocked, vaultMessage } from "./api";
import "./quick-access.css";

/**
 * The part of the desktop shell this panel uses. Matched structurally on `window.symplist.vaultPanel`
 * so the panel still renders — and still works, minus the shell verbs — in a browser and in tests.
 */
export interface VaultPanelShell {
  /** Hide the panel. The shell locks whatever this panel unlocked and answers with `onDismissed`. */
  close(): void;
  /** Writes to the system clipboard and clears it after 30 seconds if it still holds this value. */
  copy(value: string): Promise<boolean>;
  /** Opens the main Symplist window at a path on the app's own origin. */
  openApp(path: string): Promise<boolean>;
  /** Tells the shell what to draw in the menu bar and whether closing should lock. */
  report(state: { unlocked: boolean; unlockedHere: boolean; email: string | null }): void;
  /** Asks the shell to size the window to the panel's content. */
  resize(height: number): void;
  /** The panel was shown again; re-read the vault state. Returns the unsubscribe. */
  onShown(listener: () => void): () => void;
  /** The panel was hidden. Forget everything on screen. Returns the unsubscribe. */
  onDismissed(listener: () => void): () => void;
}

function shellFromWindow(): VaultPanelShell | null {
  if (typeof window === "undefined") return null;
  const panel = (window as { symplist?: { vaultPanel?: unknown } }).symplist?.vaultPanel;
  if (typeof panel !== "object" || panel === null) return null;
  const candidate = panel as Record<string, unknown>;
  const verbs = ["close", "copy", "openApp", "report", "resize", "onShown", "onDismissed"];
  if (verbs.some((name) => typeof candidate[name] !== "function")) return null;
  return panel as VaultPanelShell;
}

/** How long a copied value stays on the clipboard. The shell enforces it; this is the copy that says so. */
const CLIPBOARD_SECONDS = 30;

/** The height bounds the shell is asked to stay inside when it sizes the window to the content. */
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 560;

/** How long the wrong-passphrase shake runs. Matches the `sym-qv-shake` animation. */
const SHAKE_MS = 420;

type Phase = "loading" | "signed_out" | "not_created" | "locked" | "items" | "error";

/**
 * A keyboard hint: `⌘F` on a Mac, `Ctrl+F` everywhere else. The hints are visible copy, so they have to
 * be true on the machine reading them; the platform comes from the user agent because a keyboard hint is
 * not worth an IPC round trip.
 */
export function shortcutLabel(key: string, userAgent: string): string {
  return /mac/i.test(userAgent) ? `⌘${key}` : `Ctrl+${key}`;
}

function typeLabel(type: VaultItem["type"]): string {
  return type === "secret" ? "Secret" : "Secure note";
}

function shortDate(at: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at);
}

/** `4:32`, counting down to the idle expiry the api reported. Never negative. */
export function countdownLabel(idleExpiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((idleExpiresAt - now) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The message shown for a failed unlock. The panel says "passphrase" where the full screen says "key". */
export function panelMessage(error: unknown): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code === "vault.incorrect_key") return "That passphrase didn’t match. Try again.";
  return vaultMessage(error);
}

function LockGlyph({ open = false }: { readonly open?: boolean }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect
        x="4"
        y="11"
        width="16"
        height="10"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d={open ? "M10.5 11V7.5a4 4 0 0 1 8 0" : "M8 11V7.5a4 4 0 0 1 8 0V11"}
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function KeyGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="2" />
      <path
        d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function NoteGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M6 3h9l4 4v14H6z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M9 12h7M9 16h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function SearchGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function EyeGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.9" />
    </svg>
  );
}

function CheckGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="m5 12 5 5L20 7"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function BackGlyph(): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="m15 18-6-6 6-6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export interface VaultQuickAccessProps {
  /** Injected by tests; the shared client otherwise. */
  readonly api?: VaultApi;
  /** Injected by tests; read off `window.symplist.vaultPanel` otherwise. */
  readonly shell?: VaultPanelShell | null;
}

export function VaultQuickAccess({
  api: providedApi,
  shell: providedShell,
}: VaultQuickAccessProps = {}): ReactElement {
  const [api] = useState(() => providedApi ?? getVaultApi());
  const [shell] = useState<VaultPanelShell | null>(() =>
    providedShell === undefined ? shellFromWindow() : providedShell,
  );
  const session = useSession();

  const [phase, setPhase] = useState<Phase>("loading");
  const [page, setPage] = useState<VaultItemsResponse | null>(null);
  const [idleExpiresAt, setIdleExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [detail, setDetail] = useState<VaultItem | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [shaking, setShaking] = useState(false);

  const unlockedHere = useRef(false);
  const epoch = useRef(0);
  const unlockKey = useRef<string | null>(null);
  const lastTouch = useRef(0);
  const passphraseInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const shortcut = (key: string): string => shortcutLabel(key, agent);

  const items = useMemo(() => {
    const all = page?.items ?? [];
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return all;
    return all.filter((item) => item.title.toLocaleLowerCase().includes(needle));
  }, [page, query]);

  /** Forgets everything on screen. Called on lock, on dismissal, and whenever the vault relocks. */
  const forget = useCallback((next: Phase) => {
    epoch.current++;
    unlockedHere.current = false;
    setPage(null);
    setDetail(null);
    setDetailBusy(false);
    setRevealed(false);
    setCopied(false);
    setQuery("");
    setCursor(0);
    setPassphrase("");
    setIdleExpiresAt(null);
    setBusy(false);
    setError("");
    setPhase(next);
  }, []);

  const load = useCallback(async () => {
    const request = ++epoch.current;
    setError("");
    try {
      const state = await api.status();
      if (request !== epoch.current) return;
      if (state.state === "not_created") {
        setPhase("not_created");
        return;
      }
      if (state.state === "locked") {
        setIdleExpiresAt(null);
        setPhase("locked");
        return;
      }
      const listed = await api.list();
      if (request !== epoch.current) return;
      setPage(listed);
      setIdleExpiresAt(listed.idleExpiresAt);
      setCursor(0);
      setPhase("items");
    } catch (failure) {
      if (request !== epoch.current) return;
      if (vaultIsLocked(failure)) {
        setPhase("locked");
        return;
      }
      setError(panelMessage(failure));
      setPhase("error");
    }
  }, [api]);

  // The session is the outer question: a panel on a Mac that has never signed in shows the sign-in
  // notice, not a passphrase prompt, and asks the api nothing at all.
  useEffect(() => {
    if (session.status === "loading") return;
    if (session.status === "signed_out") {
      forget("signed_out");
      return;
    }
    void load();
  }, [session.status, load, forget]);

  // The shell shows and hides one window rather than building a new one each time, so the panel is
  // told about both, and treats dismissal as a lock.
  useEffect(() => {
    if (!shell) return;
    const offShown = shell.onShown(() => {
      if (session.status === "signed_in") void load();
    });
    const offDismissed = shell.onDismissed(() => {
      const lockIt = unlockedHere.current;
      forget(session.status === "signed_out" ? "signed_out" : "locked");
      if (lockIt) void api.lock().catch(() => undefined);
    });
    return () => {
      offShown();
      offDismissed();
    };
  }, [shell, load, forget, api, session.status]);

  // The menu-bar icon is drawn open while the vault is unlocked, and the shell needs to know whether
  // closing the panel should lock what the panel opened.
  useEffect(() => {
    shell?.report({
      unlocked: phase === "items",
      unlockedHere: phase === "items" && unlockedHere.current,
      email: session.user?.email ?? null,
    });
  }, [shell, phase, session.user?.email]);

  // The window hugs its content, the way each state of the panel does in the mockup.
  useEffect(() => {
    const element = panel.current;
    if (!shell || !element || typeof ResizeObserver === "undefined") return;
    const report = () => {
      const height = Math.round(element.getBoundingClientRect().height);
      if (height > 0) shell.resize(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [shell]);

  useEffect(() => {
    if (phase !== "items" || idleExpiresAt === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [phase, idleExpiresAt]);

  // The api's idle window is the authority; this only stops showing items once it has passed.
  useEffect(() => {
    if (phase !== "items" || idleExpiresAt === null || now < idleExpiresAt) return;
    forget("locked");
    void api.lock().catch(() => undefined);
  }, [phase, idleExpiresAt, now, forget, api]);

  useEffect(() => {
    if (phase === "locked") passphraseInput.current?.focus();
    if (phase === "items" && !detail) searchInput.current?.focus();
  }, [phase, detail]);

  useEffect(() => {
    if (detail) detailHeading.current?.focus();
  }, [detail]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    if (!shaking) return;
    const timer = setTimeout(() => setShaking(false), SHAKE_MS);
    return () => clearTimeout(timer);
  }, [shaking]);

  useEffect(() => {
    setCursor((index) => (items.length === 0 ? 0 : Math.min(index, items.length - 1)));
  }, [items.length]);

  const relock = useCallback(() => {
    forget("locked");
    void api.lock().catch(() => undefined);
  }, [api, forget]);

  const touch = useCallback(async () => {
    if (phase !== "items" || Date.now() - lastTouch.current < 60_000) return;
    lastTouch.current = Date.now();
    const request = epoch.current;
    try {
      const next = await api.touch();
      if (request === epoch.current) setIdleExpiresAt(next.idleExpiresAt);
    } catch (failure) {
      if (request === epoch.current && vaultIsLocked(failure)) forget("locked");
    }
  }, [api, phase, forget]);

  const copyValue = useCallback(
    async (value: string) => {
      if (shell) {
        const ok = await shell.copy(value);
        setCopied(ok);
        if (!ok) setError("Couldn’t reach the clipboard. Reveal the value to copy it by hand.");
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      } catch {
        setError("Couldn’t reach the clipboard. Reveal the value to copy it by hand.");
      }
    },
    [shell],
  );

  /** Copies an item without putting it on screen: the list reads it and hands it straight over. */
  const copyItem = useCallback(
    async (id: string) => {
      const request = epoch.current;
      setError("");
      try {
        const item = await api.read(id);
        if (request !== epoch.current) return;
        await copyValue(item.value);
      } catch (failure) {
        if (request !== epoch.current) return;
        if (vaultIsLocked(failure)) forget("locked");
        else setError(panelMessage(failure));
      }
    },
    [api, copyValue, forget],
  );

  const openItem = useCallback(
    async (id: string) => {
      const request = ++epoch.current;
      setError("");
      setRevealed(false);
      setCopied(false);
      setDetail(null);
      setDetailBusy(true);
      try {
        const item = await api.read(id);
        if (request !== epoch.current) return;
        setDetail(item);
      } catch (failure) {
        if (request !== epoch.current) return;
        if (vaultIsLocked(failure)) forget("locked");
        else setError(panelMessage(failure));
      } finally {
        if (request === epoch.current) setDetailBusy(false);
      }
    },
    [api, forget],
  );

  const backToList = useCallback(() => {
    setDetail(null);
    setDetailBusy(false);
    setRevealed(false);
    setCopied(false);
    setError("");
    searchInput.current?.focus();
  }, []);

  const openApp = useCallback(
    (path: string) => {
      if (shell) void shell.openApp(path);
      else window.location.assign(path);
    },
    [shell],
  );

  async function unlock(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (busy || passphrase.length === 0) return;
    setBusy(true);
    setError("");
    unlockKey.current ??= crypto.randomUUID();
    try {
      await api.unlock(passphrase, unlockKey.current);
      unlockedHere.current = true;
      unlockKey.current = null;
      setPassphrase("");
      await load();
    } catch (failure) {
      // The field keeps what was typed, selected, so a typo is a correction rather than a retype.
      setError(panelMessage(failure));
      setShaking(true);
      passphraseInput.current?.focus();
      passphraseInput.current?.select();
    } finally {
      setBusy(false);
    }
  }

  // One keyboard model for the whole panel, bound to the window so it works wherever focus sits. The
  // hints in the footer are the specification: ↑↓ move, ↵ copies, ⌘↵ opens, ⌘F searches, ⌘L locks.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const accel = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        event.preventDefault();
        if (detail) backToList();
        else shell?.close();
        return;
      }
      if (accel && (event.key === "l" || event.key === "L")) {
        event.preventDefault();
        if (phase === "items") relock();
        return;
      }
      if (phase !== "items") return;
      if (accel && (event.key === "f" || event.key === "F")) {
        event.preventDefault();
        if (detail) backToList();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }
      if (accel && (event.key === "c" || event.key === "C")) {
        // A real text selection keeps the platform copy; this is the "nothing selected" shortcut.
        if ((window.getSelection()?.toString() ?? "").length > 0) return;
        event.preventDefault();
        if (detail) {
          void copyValue(detail.value);
          return;
        }
        const selected = items[cursor];
        if (selected) void copyItem(selected.id);
        return;
      }
      if (detail) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (items.length === 0) return;
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setCursor((index) => Math.min(items.length - 1, Math.max(0, index + step)));
        return;
      }
      if (event.key === "Enter") {
        const selected = items[cursor];
        if (!selected) return;
        event.preventDefault();
        if (accel) void openItem(selected.id);
        else void copyItem(selected.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, detail, items, cursor, backToList, copyItem, copyValue, openItem, relock, shell]);

  const remaining = idleExpiresAt === null ? null : countdownLabel(idleExpiresAt, now);
  const email = session.user?.email ?? null;
  const clipboardNote = `The clipboard clears in ${CLIPBOARD_SECONDS} seconds.`;

  const appLink = (label: string, path: string): ReactElement => (
    <button type="button" className="sym-qv-link" onClick={() => openApp(path)}>
      {label}
    </button>
  );

  const copyButton = (value: string): ReactElement => (
    <button
      type="button"
      className={`sym-qv-copy${copied ? " sym-qv-copy--done" : ""}`}
      onClick={() => void copyValue(value)}
    >
      {copied ? (
        <>
          <CheckGlyph />
          Copied
        </>
      ) : (
        "Copy"
      )}
    </button>
  );

  if (phase === "signed_out") {
    return (
      <main ref={panel} className="sym-qv" data-phase="signed_out">
        <section className="sym-qv-empty">
          <SymplistMark className="sym-qv-mark" />
          <h1>Sign in to use the vault here</h1>
          <p>
            Your session ended or this Mac hasn’t signed in yet. Sign in once in Symplist, then come
            back.
          </p>
          <button type="button" className="sym-qv-primary" onClick={() => openApp("/signin")}>
            Open Symplist to sign in
          </button>
        </section>
      </main>
    );
  }

  return (
    <main
      ref={panel}
      className={`sym-qv${shaking ? " sym-qv-shake" : ""}`}
      data-phase={phase}
      onPointerDown={() => void touch()}
      onKeyDown={() => void touch()}
    >
      <header className="sym-qv-bar">
        {detail ? (
          <>
            <button
              type="button"
              className="sym-qv-icon"
              aria-label="Back to items"
              onClick={backToList}
            >
              <BackGlyph />
            </button>
            <h1 className="sym-qv-title" ref={detailHeading} tabIndex={-1}>
              {detail.title}
            </h1>
          </>
        ) : (
          <>
            <SymplistMark className="sym-qv-bar-mark" />
            <h1 className="sym-qv-title">Vault</h1>
          </>
        )}
        {phase === "items" && remaining !== null ? (
          <span className="sym-qv-pill">Locks in {remaining}</span>
        ) : null}
        {phase === "items" && !detail ? (
          <button
            type="button"
            className="sym-qv-icon"
            aria-label="Lock now"
            title="Lock now"
            onClick={relock}
          >
            <LockGlyph />
          </button>
        ) : null}
        {phase !== "items" && email ? <span className="sym-qv-account">{email}</span> : null}
      </header>

      {phase === "loading" ? (
        <p className="sym-qv-status" role="status">
          Opening your vault…
        </p>
      ) : null}

      {phase === "error" ? (
        <section className="sym-qv-empty">
          <span className="sym-qv-avatar sym-qv-avatar--danger">
            <LockGlyph />
          </span>
          <h2>Couldn’t reach your vault</h2>
          <p role="alert">{error}</p>
          <button type="button" className="sym-qv-primary" onClick={() => void load()}>
            Try again
          </button>
        </section>
      ) : null}

      {phase === "not_created" ? (
        <section className="sym-qv-empty">
          <span className="sym-qv-avatar">
            <LockGlyph />
          </span>
          <h2>Set up your vault first</h2>
          <p>
            You don’t have a vault yet. Create one in Symplist with a passphrase, then come back.
          </p>
          <button type="button" className="sym-qv-primary" onClick={() => openApp("/vault")}>
            Open Symplist to set up
          </button>
        </section>
      ) : null}

      {phase === "locked" ? (
        <form className="sym-qv-unlock" onSubmit={unlock} aria-busy={busy}>
          <span className={`sym-qv-avatar${error ? " sym-qv-avatar--danger" : ""}`}>
            <LockGlyph />
          </span>
          <h2>Your vault is locked</h2>
          <p>Enter your vault passphrase. It is separate from signing in.</p>
          <label className="sr-only" htmlFor={fieldId}>
            Vault passphrase
          </label>
          <input
            id={fieldId}
            ref={passphraseInput}
            className="sym-qv-input"
            type="password"
            value={passphrase}
            autoComplete="current-password"
            maxLength={1024}
            aria-invalid={error.length > 0}
            {...(error ? { "aria-describedby": errorId } : {})}
            onChange={(event) => {
              unlockKey.current = null;
              setPassphrase(event.target.value);
              setError("");
            }}
          />
          {error ? (
            <p id={errorId} className="sym-qv-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="sym-qv-primary"
            disabled={busy || passphrase.length === 0}
          >
            {busy ? "Unlocking…" : "Unlock"}
          </button>
        </form>
      ) : null}

      {phase === "items" && !detail ? (
        <>
          <div className="sym-qv-search">
            <SearchGlyph />
            <input
              ref={searchInput}
              type="search"
              aria-label="Search vault"
              placeholder="Search vault"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd>{shortcut("F")}</kbd>
          </div>
          {error ? (
            <p className="sym-qv-error" role="alert">
              {error}
            </p>
          ) : null}
          {copied ? (
            <p className="sym-qv-copied" role="status">
              Copied. {clipboardNote}
            </p>
          ) : null}
          {detailBusy ? (
            <p className="sym-qv-status" role="status">
              Opening item…
            </p>
          ) : null}
          {items.length === 0 ? (
            <p className="sym-qv-status">
              {query
                ? "No item matches that."
                : "Nothing in your vault yet. Add a secret or a secure note in Symplist."}
            </p>
          ) : (
            <ul className="sym-qv-list">
              {items.map((item, index) => (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={index === cursor ? "true" : undefined}
                    onFocus={() => setCursor(index)}
                    onClick={() => void openItem(item.id)}
                  >
                    <span className="sym-qv-item-icon">
                      {item.type === "secret" ? <KeyGlyph /> : <NoteGlyph />}
                    </span>
                    <span className="sym-qv-item-text">
                      <span className="sym-qv-item-title">{item.title}</span>
                      <span className="sym-qv-item-meta">
                        {typeLabel(item.type)} · {shortDate(item.updatedAt)}
                      </span>
                    </span>
                    {index === cursor ? (
                      <span className="sym-qv-return" aria-hidden="true">
                        ↵
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {page?.nextCursor ? (
            <p className="sym-qv-note">
              Showing your most recent items. Open the full vault for the rest.
            </p>
          ) : null}
        </>
      ) : null}

      {phase === "items" && detail ? (
        <section className="sym-qv-detail" aria-label="Vault item">
          <div className="sym-qv-chips">
            <span className="sym-qv-chip">{typeLabel(detail.type)}</span>
            <span className="sym-qv-chip-plain">Modified {shortDate(detail.updatedAt)}</span>
          </div>
          <div className="sym-qv-field">
            <span className="sym-qv-label">{detail.type === "secret" ? "Value" : "Note"}</span>
            {detail.type === "secret" ? (
              <>
                <div className="sym-qv-value">
                  <output aria-label={revealed ? "Revealed value" : "Hidden value"}>
                    {revealed ? detail.value : "••••••••••••••••"}
                  </output>
                  <button
                    type="button"
                    className="sym-qv-icon"
                    aria-label={revealed ? "Hide" : "Reveal"}
                    title={revealed ? "Hide" : "Reveal"}
                    aria-pressed={revealed}
                    onClick={() => setRevealed((shown) => !shown)}
                  >
                    <EyeGlyph />
                  </button>
                  {copyButton(detail.value)}
                </div>
                <span className="sym-qv-note">{clipboardNote}</span>
              </>
            ) : (
              <>
                <p className="sym-qv-note-body">{detail.value}</p>
                <div className="sym-qv-value sym-qv-value--plain">
                  {copyButton(detail.value)}
                  <span className="sym-qv-note">{clipboardNote}</span>
                </div>
              </>
            )}
          </div>
          {error ? (
            <p className="sym-qv-error" role="alert">
              {error}
            </p>
          ) : null}
        </section>
      ) : null}

      <footer className="sym-qv-foot">
        {phase === "items" ? (
          detail ? (
            <>
              {appLink("Edit in Symplist ↗", `/vault/items/${detail.id}`)}
              <span className="sym-qv-keys">{shortcut("C")} copy · esc back</span>
            </>
          ) : (
            <>
              {appLink("Open full vault ↗", "/vault")}
              <span className="sym-qv-keys">↑↓ ↵ · {shortcut("L")} lock</span>
            </>
          )
        ) : (
          <>
            {appLink("Open Symplist", "/now")}
            <span>Locks when this panel closes</span>
          </>
        )}
      </footer>
    </main>
  );
}
