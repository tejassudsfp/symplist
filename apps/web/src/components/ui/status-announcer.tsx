"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type Politeness = "polite" | "assertive";

export interface Announcer {
  /** Announces a short status message; repeating the same text is announced again. */
  announce(message: string, politeness?: Politeness): void;
}

const AnnouncerContext = createContext<Announcer | null>(null);

/** How long an announcement stays in the live region before it is cleared. */
export const ANNOUNCEMENT_CLEAR_MS = 7000;

/**
 * Two persistent visually hidden live regions (polite and assertive) for status announcements such as
 * "Saved", "Task moved to Later" or a disabled shortcut's reason (system_states.md). The regions exist
 * before any message is inserted, so screen readers reliably pick changes up.
 */
export function StatusAnnouncerProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<Record<Politeness, { text: string; id: number }>>({
    polite: { text: "", id: 0 },
    assertive: { text: "", id: 0 },
  });
  const counter = useRef(0);
  const timers = useRef<Partial<Record<Politeness, ReturnType<typeof setTimeout>>>>({});

  const announce = useCallback((message: string, politeness: Politeness = "polite") => {
    const text = message.trim();
    if (!text) return;
    counter.current += 1;
    const id = counter.current;
    // Clear first so an identical repeated message still changes the region's content.
    setMessages((current) => ({ ...current, [politeness]: { text: "", id } }));
    queueMicrotask(() => {
      setMessages((current) =>
        current[politeness].id === id ? { ...current, [politeness]: { text, id } } : current,
      );
    });
    const existing = timers.current[politeness];
    if (existing) clearTimeout(existing);
    timers.current[politeness] = setTimeout(() => {
      setMessages((current) =>
        current[politeness].id === id ? { ...current, [politeness]: { text: "", id } } : current,
      );
    }, ANNOUNCEMENT_CLEAR_MS);
  }, []);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of Object.values(pending)) if (timer) clearTimeout(timer);
    };
  }, []);

  const value = useMemo<Announcer>(() => ({ announce }), [announce]);

  return (
    <AnnouncerContext.Provider value={value}>
      {children}
      <div className="sr-only" data-slot="status-announcer">
        <div role="status" aria-live="polite" aria-atomic="true">
          {messages.polite.text}
        </div>
        <div role="alert" aria-live="assertive" aria-atomic="true">
          {messages.assertive.text}
        </div>
      </div>
    </AnnouncerContext.Provider>
  );
}

export function useAnnouncer(): Announcer {
  const announcer = useContext(AnnouncerContext);
  if (!announcer) throw new Error("useAnnouncer must be used inside StatusAnnouncerProvider");
  return announcer;
}
