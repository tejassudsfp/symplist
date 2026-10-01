"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, which is what makes Symplist installable.
 *
 * Production only: in development Next serves modules the worker would happily cache and then serve
 * stale, and debugging that is a worse afternoon than not having it. Registration is deliberately
 * deferred to `load` — it is never on the critical path of the first paint, and a worker that
 * competes with the app's own JavaScript for the main thread makes the first visit slower, which is
 * the opposite of the point.
 */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      // A failure here is not worth an error to the person: the app works without it, and all they
      // lose is the ability to install.
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
