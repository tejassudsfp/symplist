"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * Offering to install Symplist, on the platforms that can.
 *
 * Two different things wear one label here, because to the person they are the same thing:
 *
 * - **Chrome, Edge and Android** fire `beforeinstallprompt`, which can be deferred and replayed from
 *   a real click. That is a true one-tap install.
 * - **iOS and iPadOS** never fire it. Safari installs only from its own Share → Add to Home Screen,
 *   and no script can open that sheet. So on iOS this tells them where it is rather than pretending
 *   to do it for them — a button that looks like it installs and then does nothing is worse than a
 *   sentence that explains.
 *
 * It renders nothing at all when the app is already installed, when the browser cannot install, or
 * once the person has dismissed it. Nobody needs to be asked twice.
 */

/** The event Chromium fires; not in the DOM lib, because it is not standard. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISSED_KEY = "symplist.install.dismissed";

/** Whether the page is already running as an installed app, on either platform's spelling. */
function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches ?? false;
  // iOS predates `display-mode` and reports it here instead.
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

/** iOS and iPadOS, including an iPad reporting itself as a Mac — which it does, with a touch screen. */
function isApplePortable(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
}

export function InstallPrompt({ className }: { readonly className?: string }) {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [showIosHint, setShowIosHint] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    if (isInstalled()) return;
    // A refused offer stays refused. Browser storage can throw in a private window, and a prompt that
    // cannot remember a dismissal is better than a screen that cannot render.
    try {
      if (window.localStorage.getItem(DISMISSED_KEY) === "1") return;
    } catch {
      // Ignored: an unreadable store just means the offer is shown again.
    }
    setDismissed(false);
    if (isApplePortable()) setShowIosHint(true);

    const onPrompt = (incoming: Event) => {
      // Chromium shows its own mini-infobar unless this is called; we want it on our terms.
      incoming.preventDefault();
      setEvent(incoming as InstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    const onInstalled = () => setEvent(null);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const close = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Ignored: the offer returns next time, which is the harmless failure.
    }
  };

  if (dismissed || (!event && !showIosHint)) return null;

  return (
    <div className={className} data-testid="install-prompt">
      {event ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={async () => {
            await event.prompt();
            const { outcome } = await event.userChoice;
            if (outcome === "accepted") setEvent(null);
            close();
          }}
        >
          Install Symplist
        </Button>
      ) : (
        <p className="m-0 text-[12.5px] text-sym-muted">
          Add Symplist to your home screen: <span className="text-sym-text">Share</span> →{" "}
          <span className="text-sym-text">Add to Home Screen</span>.
        </p>
      )}
      <Button size="sm" variant="ghost" onClick={close}>
        Not now
      </Button>
    </div>
  );
}
