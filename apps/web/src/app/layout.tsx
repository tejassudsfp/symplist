import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { AppProviders } from "@/components/app-providers";
import { NONCE_HEADER } from "@/lib/security/headers";
import { APPEARANCE_COOKIE, parseAppearanceCookie } from "@/theme/appearance";
import { APPEARANCE_STYLE_ELEMENT_ID } from "@/theme/appearance-client";
import { buildAppearanceCss } from "@/theme/css";
import { fontVariableClassNames } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Symplist",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * The root layout reads only non-sensitive request state: the `sym_appearance` display cookie, so the
 * theme renders without a flash (§10.3), and the per-request CSP nonce set by the proxy (§10.4). It
 * never calls the API (§5.1).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const appearance = parseAppearanceCookie(cookieStore.get(APPEARANCE_COOKIE)?.value);
  const nonce = headerStore.get(NONCE_HEADER) ?? undefined;
  return (
    <html
      lang="en"
      data-theme={appearance.themeId}
      data-mode={appearance.mode}
      className={fontVariableClassNames}
      suppressHydrationWarning
    >
      <head>
        <style
          id={APPEARANCE_STYLE_ELEMENT_ID}
          nonce={nonce}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: built only from the theme registry and a validated hex seed; every declaration is checked before emitting.
          dangerouslySetInnerHTML={{ __html: buildAppearanceCss(appearance) }}
        />
      </head>
      <body>
        <AppProviders nonce={nonce}>{children}</AppProviders>
      </body>
    </html>
  );
}
