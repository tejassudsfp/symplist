export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-[720px] px-6 py-12 text-sym-text">
      <h1 className="font-heading text-2xl">Privacy in Symplist</h1>
      <p>
        Tasks, documents, chats and other private content are encrypted at rest. The service can
        read content to provide the features you request. This is not end-to-end encryption.
      </p>
      <h2 className="mt-8 font-heading text-xl">Optional product usage</h2>
      <p>
        Product analytics is off until you accept. When enabled, PostHog US cloud receives a random
        analytics-only identifier and categories such as which theme you chose or whether you
        created a task. It does not receive your name, email, task or document text, chats, search
        terms, Vault data, passwords or share links. There is no session recording, advertising
        tracking or automatic browsing history collection.
      </p>
      <p>
        You can decline just as easily as accept, or turn usage sharing off in Settings → Account →
        Privacy. This does not change access to tasks, Simon or reminders. Analytics is not loaded
        on sign-in, Vault, consent or shared artifact pages.
      </p>
      <h2 className="mt-8 font-heading text-xl">Deletion and copies</h2>
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
      <a href="/settings/account">Back to account settings</a>
    </main>
  );
}
