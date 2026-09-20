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

const DESCRIPTION = "A calm task workspace. Every task has a page and a conversation.";

/*
 * `metadataBase` resolves the relative asset paths below into the absolute URLs that link previews
 * require; it comes from the public web origin so a preview never points at localhost. The share
 * card is a committed PNG rather than a generated `opengraph-image`, so a preview never depends on
 * a font fetch or a render at request time.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_WEB_ORIGIN ?? "https://symplist.tejassuds.com"),
  title: { default: "Symplist", template: "%s · Symplist" },
  description: DESCRIPTION,
  applicationName: "Symplist",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Symplist", statusBarStyle: "black-translucent" },
  openGraph: {
    type: "website",
    siteName: "Symplist",
    title: "Symplist",
    description: DESCRIPTION,
    url: "/",
    images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: "Symplist" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Symplist",
    description: DESCRIPTION,
    images: [{ url: "/brand/twitter.png", width: 1200, height: 600, alt: "Symplist" }],
  },
  // The workspace is private: a task page must never be indexed or previewed by a crawler.
  robots: { index: false, follow: false, nocache: true },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  /*
   * Only the browser chrome around the page, not a theme token: the app ships six themes and the
   * user picks the accent, so these are the neutral grounds the default theme resolves to rather
   * than an attempt to track the active theme.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F6F5F2" },
    { media: "(prefers-color-scheme: dark)", color: "#1A1917" },
  ],
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
