import type { Metadata } from "next";
import { LegalPage, SITE } from "@/features/marketing/site-chrome";

export const metadata: Metadata = {
  title: "Cookies — Symplist",
  description: "The few cookies Symplist sets, and what each one is for.",
};

export default function CookiesPage() {
  return (
    <LegalPage title="Cookies" updated="1 October 2026">
      <p>
        Symplist sets no advertising cookies, no tracking cookies and no third-party cookies. There
        is no cookie banner because there is nothing to consent to: every cookie below is needed for
        the thing you asked the service to do.
      </p>

      <h2>What is set</h2>
      <dl className="sym-legal-list">
        <div>
          <dt>Session</dt>
          <dd>
            Keeps you signed in. <code>HttpOnly</code>, <code>Secure</code> and{" "}
            <code>SameSite</code>-restricted, so it cannot be read by scripts and does not travel to
            other sites. Removed when you sign out.
          </dd>
        </div>
        <div>
          <dt>CSRF token</dt>
          <dd>
            Paired with a header on every write, so another site cannot make a change on your
            behalf.
          </dd>
        </div>
        <div>
          <dt>Appearance</dt>
          <dd>
            Remembers your theme and light/dark choice so the first paint after a reload is not the
            wrong colour. It holds a theme name and nothing about you.
          </dd>
        </div>
        <div>
          <dt>Shared link access</dt>
          <dd>
            Set only on the separate artifact host, and only once you unlock a password-protected
            shared page. It is scoped to that host, so it never touches your workspace.
          </dd>
        </div>
      </dl>

      <h2>Analytics</h2>
      <p>
        Product analytics is off until you explicitly accept it, and it uses a random analytics-only
        identifier rather than a cookie that identifies you. Session replay and autocapture are
        disabled. If you decline — or never answer — nothing analytics-related is loaded at all, and
        nothing about your access changes. You can change your mind in Settings → Account → Privacy.
        See <a href="/privacy">Privacy</a> for what is and is not collected.
      </p>

      <h2>Clearing them</h2>
      <p>
        Signing out removes the session. Clearing site data in your browser removes the rest; you
        will simply be signed out and back on the default theme. Questions to{" "}
        <a href={`mailto:${SITE.privacyContact}`}>{SITE.privacyContact}</a>.
      </p>
    </LegalPage>
  );
}
