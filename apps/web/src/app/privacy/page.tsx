import type { Metadata } from "next";
import { LegalPage, SITE } from "@/features/marketing/site-chrome";

export const metadata: Metadata = {
  title: "Privacy — Symplist",
  description: "What Symplist stores, what it encrypts, and what it never collects.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy" updated="1 October 2026">
      <p>
        Tasks, documents and other private content are encrypted at rest. The service can read
        content to provide the features you request. This is not end-to-end encryption.
      </p>
      <h2>Optional product usage</h2>
      <p>
        Product analytics is off until you accept. When enabled, PostHog US cloud receives a random
        analytics-only identifier and categories such as which theme you chose or whether you
        created a task. It does not receive your name, email, task or document text, search terms,
        Vault data, passwords or share links. There is no session recording, advertising tracking or
        automatic browsing history collection.
      </p>
      <p>
        You can decline just as easily as accept, or turn usage sharing off in Settings → Account →
        Privacy. This does not change access to tasks or reminders. Analytics is not loaded on
        sign-in, Vault, consent or shared artifact pages.
      </p>
      <h2>Deletion and copies</h2>
      <p>
        Account deletion removes the active encryption key immediately and requests deletion of
        analytics data. Database recovery history can retain previous keys for up to 30 days;
        provider deletion is asynchronous. Emails, downloaded documents and copies already fetched
        from a shared link cannot be recalled.
      </p>
      <p>
        Deployment operators must configure a 30-day analytics retention policy or an equivalent
        deletion schedule before enabling collection. See{" "}
        <a href="https://posthog.com/privacy" rel="noopener noreferrer">
          PostHog’s privacy information
        </a>{" "}
        for its subprocessors and handling.
      </p>
      <h2>Contact</h2>
      <p>
        <a href={`mailto:${SITE.privacyContact}`}>{SITE.privacyContact}</a> for anything about your
        data, a copy of it, or its deletion. To report a vulnerability privately, write to{" "}
        <a href={`mailto:${SITE.securityContact}`}>{SITE.securityContact}</a> rather than opening a
        public issue.
      </p>
    </LegalPage>
  );
}
