import Link from "next/link";
import { SymplistMark } from "@/components/brand/logo";
import { PageAppearanceProvider } from "./appearance";
import { AskYourAi } from "./ask-your-ai";
import { SITE, SiteFooter, SiteHeader } from "./site-chrome";
import { ThemeCards } from "./theme-cards";
import { ThemeSwitcher } from "./theme-switcher";
import { VaultPreview } from "./vault-preview";
import { WorkspaceDemo } from "./workspace-demo";

/**
 * What Symplist is, in the order a stranger needs it: the claim, the product itself, the three lists,
 * what opens up when you want it, the six looks, whose assistant it uses, and what it will and will
 * not say about your data.
 *
 * One page on purpose. A product whose thesis is that the simplest thing usually wins cannot open
 * with a tour.
 */

const lists = [
  { name: "Now", body: "What you have decided to do. Nothing lands here on its own." },
  { name: "Later", body: "Real, just not today. It waits without an overdue badge." },
  {
    name: "Unclassified",
    body: "Somewhere for a thought to sit until you know what it is.",
  },
];

const features = [
  {
    title: "A page, not a notes field",
    body: "Headings, checklists and tables in plain Markdown. Every save is a Git commit you can compare and restore.",
  },
  {
    title: "Labels, if you want them",
    body: "A word and a colour for a slice of your list. Accounts without labels never see the feature.",
  },
  {
    title: "Time that stays calm",
    body: "Optional deadlines, a calendar, quiet hours and snooze. A date never moves a task for you.",
  },
  {
    title: "A vault with its own key",
    body: "Sensitive notes and keys sit behind a separate passphrase that signing in does not unlock.",
  },
  {
    title: "Handoffs that expire",
    body: "Share a read-only snapshot of a page with a link that expires, a password, or explicit public publication.",
  },
  {
    title: "Yours to run",
    body: "MIT licensed. The self-hosting template boots on local SQLite with no third-party accounts.",
  },
];

const plainly = [
  {
    title: "Encrypted at rest",
    body: "Task titles, pages, labels and vault entries are encrypted before they are stored. Your email is not; it is how you sign in.",
  },
  {
    title: "Not end-to-end",
    body: "The service holds the keys so it can search and render your content. We would rather say so than imply otherwise.",
  },
  {
    title: "Analytics off by default",
    body: "No session recording, no ad trackers, and never any task or page text. Declining is as easy as accepting.",
  },
  {
    title: "Free, with nothing above it",
    body: "No billing, no quotas, no held-back features. If that ever changes, it changes in the open.",
  },
];

export function HomeScreen() {
  return (
    <PageAppearanceProvider>
      <div className="sym-site">
        <SiteHeader sections />
        <main id="top">
          <section className="sym-hero">
            <p className="sym-hero-eyebrow">
              <span aria-hidden="true" className="sym-hero-dot" />
              Open source · MIT · Free, with no plan above it
            </p>
            <h1 className="sym-hero-title">The most productive thing is often the most simple.</h1>
            <p className="sym-hero-lede">
              Three lists, and a real Markdown page with Git history behind every task. Nothing to
              optimise, nothing keeping score.
            </p>
            <div className="sym-hero-actions">
              <Link href={SITE.app} className="sym-button-primary">
                Start with one task <span aria-hidden="true">→</span>
              </Link>
              <a
                href={SITE.github}
                rel="noreferrer noopener"
                target="_blank"
                className="sym-button-secondary"
              >
                <GitHubMark />
                Read the source
              </a>
            </div>
            <p className="sym-hero-fine">
              Sign in with an email code. No password, no invite, no card.
            </p>
            <ThemeSwitcher />
          </section>

          <WorkspaceDemo />

          <section className="sym-section" aria-labelledby="sym-model-heading">
            <div className="sym-split">
              <div>
                <p className="sym-eyebrow">The model</p>
                <h2 id="sym-model-heading" className="sym-display">
                  Three lists. That&rsquo;s all of it.
                </h2>
                <p className="sym-model-lede">
                  Tasks move only when you move them. Finishing one archives it with its page and
                  history intact.
                </p>
              </div>
              <dl className="sym-lists">
                {lists.map((list) => (
                  <div key={list.name}>
                    <dt>
                      <SymplistMark />
                      {list.name}
                    </dt>
                    <dd>{list.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          <section className="sym-section" aria-labelledby="sym-features-heading">
            <h2 id="sym-features-heading" className="sym-display sym-features-head">
              Deeper when you need it. Out of sight when you don&rsquo;t.
            </h2>
            <ol className="sym-features">
              {features.map((feature, index) => (
                <li key={feature.title}>
                  <span className="sym-feature-n">{String(index + 1).padStart(2, "0")}</span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                </li>
              ))}
            </ol>
          </section>

          <section id="themes" className="sym-section" aria-labelledby="sym-themes-heading">
            <div className="sym-themes-head">
              <div>
                <p className="sym-eyebrow">Appearance</p>
                <h2 id="sym-themes-heading" className="sym-display">
                  Six ways for it to feel like yours.
                </h2>
              </div>
              <p className="sym-section-lede">
                Each style changes type, spacing and shape, not just colour, and comes in light and
                dark. Pick one; this page follows.
              </p>
            </div>
            <ThemeCards />
          </section>

          <VaultPreview />

          <AskYourAi />

          <section className="sym-section" aria-labelledby="sym-plain-heading">
            <div className="sym-split">
              <div>
                <p className="sym-eyebrow">In plain words</p>
                <h2 id="sym-plain-heading" className="sym-display">
                  What we store, and what we don&rsquo;t claim.
                </h2>
              </div>
              <dl className="sym-plainly">
                {plainly.map((item) => (
                  <div key={item.title}>
                    <dt>{item.title}</dt>
                    <dd>{item.body}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          <section className="sym-closing" aria-labelledby="sym-closing-heading">
            <SymplistMark className="sym-closing-mark" />
            <h2 id="sym-closing-heading">Start with one task.</h2>
            <p>Sign in with your email and write down the one thing you keep meaning to do.</p>
            <Link href={SITE.app} className="sym-button-primary">
              Open Symplist <span aria-hidden="true">→</span>
            </Link>
          </section>
        </main>
        <SiteFooter />
      </div>
    </PageAppearanceProvider>
  );
}

/** The source button carries GitHub's own mark, as the mockup has it. */
function GitHubMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}
