import Link from "next/link";
import type { ReactNode } from "react";
import { SymplistLogo } from "@/components/brand/logo";
import "./marketing.css";

/** Where the public pages agree the product, the source and the maintainer live. */
/** The canonical public origin, used by metadata, robots, the sitemap and llms.txt. */
export const SITE_URL = "https://symplist.app";

export const SITE = Object.freeze({
  app: "/now",
  github: "https://github.com/tejassudsfp/symplist",
  maintainer: "Tejas Parthasarathi Sudarshan",
  maintainerUrl: "https://tejassuds.com",
  contact: "hello@symplist.app",
  privacyContact: "privacy@symplist.app",
  securityContact: "security@symplist.app",
});

/** The header every public page shares: the mark, the source, and the way in. */
export function SiteHeader() {
  return (
    <header className="sym-site-header">
      <Link href="/" aria-label="Symplist home" className="sym-site-brand">
        <SymplistLogo />
      </Link>
      <nav aria-label="Site" className="sym-site-nav">
        <a href={SITE.github} rel="noreferrer noopener" target="_blank">
          GitHub
        </a>
        <Link href={SITE.app} className="sym-site-cta">
          Open Symplist
        </Link>
      </nav>
    </header>
  );
}

/** The footer every public page shares, including the three legal pages. */
export function SiteFooter() {
  return (
    <footer className="sym-site-footer">
      <div className="sym-site-footer-row">
        <SymplistLogo />
        <p className="sym-site-footer-note">
          Open source under the MIT licence. Built and maintained by{" "}
          <a href={SITE.maintainerUrl} rel="noreferrer noopener" target="_blank">
            {SITE.maintainer}
          </a>
          .
        </p>
      </div>
      <nav aria-label="Legal and source" className="sym-site-footer-links">
        <Link href="/privacy">Privacy</Link>
        <Link href="/terms">Terms</Link>
        <Link href="/cookies">Cookies</Link>
        <a href={SITE.github} rel="noreferrer noopener" target="_blank">
          Source
        </a>
        <a href={`mailto:${SITE.contact}`}>{SITE.contact}</a>
      </nav>
    </footer>
  );
}

/**
 * The frame the legal pages share: readable measure, the same header and footer as the homepage.
 *
 * `updated` is shown rather than hidden in a comment, because the one thing a person looks for on a
 * terms page is whether it changed since they last read it.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  readonly title: string;
  readonly updated: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="sym-site">
      <SiteHeader />
      <main className="sym-legal">
        <h1>{title}</h1>
        <p className="sym-legal-updated">Last updated {updated}</p>
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
