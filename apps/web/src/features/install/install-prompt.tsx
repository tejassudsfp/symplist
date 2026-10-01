"use client";

import { Share, SquarePlus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { SymplistMark } from "@/components/brand/logo";

/**
 * Offering to install Symplist, where a phone can actually do it.
 *
 * Two platforms wear one banner, because to the person they are the same wish:
 *
 * - **Android and Chromium** fire `beforeinstallprompt`, which can be held and replayed from a real
 *   click. That is a true one-tap install.
 * - **iOS and iPadOS** never fire it. Safari installs only from its own Share sheet, and no script can
 *   open that sheet — so this shows the two taps, with the system's own icons, instead of a button
 *   that would look like it installs and then do nothing.
 *
 * Dismissal lasts the session, not forever. Installing is the kind of thing somebody means to do and
 * then doesn't, and a hint they met once on a first visit is a hint they will never see again. It is
 * still one tap to clear, and it never returns once the app is installed, because `display-mode:
 * standalone` is true from inside it.
 */

/** The event Chromium fires; not in the DOM lib, because it is not a standard. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "symplist.install.dismissed";

/** Already running as an installed app, on either platform's spelling of it. */
function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  // iOS predates `display-mode` and reports it here instead.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

/** iOS or iPadOS — including an iPad, which calls itself a Macintosh and gives itself away by touch. */
function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

/** Session-scoped, so a dismissal lasts the visit and the offer returns on the next one. */
function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    // A private window can throw. An unreadable store just means the offer shows.
    return false;
  }
}

export function InstallPrompt() {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [open, setOpen] = useState(false);
  const [showSteps, setShowSteps] = useState(false);

  useEffect(() => {
    if (isInstalled() || readDismissed()) return;
    if (isIos()) {
      setIos(true);
      setOpen(true);
    }
    const onPrompt = (incoming: Event) => {
      // Chromium shows a mini-infobar of its own unless this is called.
      incoming.preventDefault();
      setEvent(incoming as InstallPromptEvent);
      setOpen(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    const onInstalled = () => setOpen(false);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    setOpen(false);
    try {
      window.sessionStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Ignored: the offer returns sooner, which is the harmless failure.
    }
  };

  if (!open) return null;

  return (
    <section className="sym-install" aria-label="Install Symplist">
      <div className="sym-install-row">
        <span aria-hidden="true" className="sym-install-icon">
          <SymplistMark />
        </span>
        <span className="sym-install-text">
          <strong>Install Symplist</strong>
          <span className="sym-install-sub">Your list, one tap from the home screen.</span>
        </span>
        {event ? (
          <button
            type="button"
            className="sym-install-action"
            onClick={async () => {
              await event.prompt();
              const { outcome } = await event.userChoice;
              if (outcome === "accepted") setOpen(false);
              else dismiss();
            }}
          >
            Install
          </button>
        ) : (
          <button
            type="button"
            className="sym-install-action"
            aria-expanded={showSteps}
            onClick={() => setShowSteps((shown) => !shown)}
          >
            How
          </button>
        )}
        <button type="button" className="sym-install-close" aria-label="Not now" onClick={dismiss}>
          <X size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      {ios && showSteps ? (
        /* Safari's own two taps, with its own icons, because nothing here can perform them. */
        <ol className="sym-install-steps">
          <li>
            <Share size={15} strokeWidth={1.9} aria-hidden="true" />
            Tap <strong>Share</strong> at the bottom of Safari
          </li>
          <li>
            <SquarePlus size={15} strokeWidth={1.9} aria-hidden="true" />
            Choose <strong>Add to Home Screen</strong>
          </li>
        </ol>
      ) : null}
    </section>
  );
}
