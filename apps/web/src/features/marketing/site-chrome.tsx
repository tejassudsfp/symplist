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

/**
 * The header every public page shares. It is sticky and translucent, so the section it names stays
 * one press away on a long page; the in-page anchors are only offered on the homepage, where they
 * point at something.
 */
export function SiteHeader({ sections = false }: { readonly sections?: boolean }) {
  return (
    <header className="sym-site-header">
      <div className="sym-site-header-inner">
        <Link href="/" aria-label="Symplist home" className="sym-site-brand">
          <SymplistLogo />
        </Link>
        <nav aria-label="Site" className="sym-site-nav">
          {sections ? (
            <>
              <a href="#product">Product</a>
              <a href="#themes">Themes</a>
              <a href="#assistant">Assistants</a>
            </>
          ) : null}
          <a href={SITE.github} rel="noreferrer noopener" target="_blank">
            GitHub
          </a>
          <Link href={SITE.app} className="sym-site-cta">
            Open Symplist
          </Link>
        </nav>
      </div>
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
