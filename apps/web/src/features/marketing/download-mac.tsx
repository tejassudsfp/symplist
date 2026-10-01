"use client";

import { useEffect, useState } from "react";
import { SITE } from "./site-chrome";

/**
 * "Download for Mac" in the hero, for the people it is actually for.
 *
 * Shown only on macOS, and not on an iPad — which reports itself as a Macintosh and would otherwise be
 * offered a .dmg it cannot open. The check is `maxTouchPoints`, the one thing that separates them.
 *
 * It renders after mount rather than on the server, because the server does not know what it is
 * talking to and a hero that reflows on hydration is worse than one that fills in. The space it takes
 * is reserved, so nothing below it moves.
 */

/**
 * macOS proper: a Macintosh with no touch screen at all.
 *
 * iPadOS reports itself as `Macintosh`, so the user agent alone would offer an iPad a .dmg it cannot
 * open. What separates them is touch — a desktop Mac reports exactly 0 points, every iPad reports
 * several — so the test is `=== 0` rather than a threshold. The coarse-pointer check is there as well
 * because the two should agree, and a device where they disagree is one to leave alone.
 */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  if (!/Macintosh|Mac OS X/.test(navigator.userAgent)) return false;
  if (navigator.maxTouchPoints !== 0) return false;
  return window.matchMedia?.("(pointer: fine)").matches !== false;
}

/** Apple's mark, drawn at the weight of the text beside it. Platform indication, which is its purpose. */
function AppleMark() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d="M16.37 12.78c.03 2.9 2.55 3.86 2.58 3.88-.02.07-.4 1.38-1.33 2.73-.8 1.17-1.63 2.33-2.95 2.35-1.29.03-1.71-.76-3.19-.76-1.48 0-1.94.74-3.16.79-1.27.05-2.24-1.26-3.05-2.42-1.65-2.4-2.92-6.77-1.22-9.72.84-1.47 2.35-2.4 3.99-2.42 1.25-.02 2.42.84 3.19.84.76 0 2.19-1.04 3.69-.89.63.03 2.4.25 3.53 1.92-.09.06-2.11 1.23-2.08 3.7M14.0 4.6c.68-.82 1.14-1.97 1.01-3.11-.98.04-2.16.65-2.86 1.47-.63.73-1.18 1.9-1.03 3.02 1.09.08 2.2-.56 2.88-1.38" />
    </svg>
  );
}

export function DownloadForMac() {
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(isMac()), []);
  if (!mac) return null;
  return (
    <a className="sym-button-secondary sym-download-mac" href={SITE.releases}>
      <AppleMark />
      Download for Mac
    </a>
  );
}
