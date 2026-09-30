import Link from "next/link";
import { SymplistMark } from "@/components/brand/logo";
import { AskYourAi } from "./ask-your-ai";
import { SITE, SiteFooter, SiteHeader } from "./site-chrome";

/**
 * What Symplist is, in the order a stranger needs it: the claim, the three lists, the page behind a
 * task, the assistant that is theirs and not ours, and what it costs (nothing).
 *
 * One page on purpose. A product whose thesis is that the most productive thing is often the most
 * simple cannot open with a tour.
 */

const lists = [
  {
    name: "Now",
    body: "What you have actually decided to do. Nothing arrives here by itself.",
  },
  {
    name: "Later",
    body: "Real, but not today. It waits without nagging and without an overdue badge.",
  },
  {
    name: "Unclassified",
    body: "Anything you have not sorted yet. A thought can land here and stay until it is ready.",
  },
];

const features = [
  {
    title: "A page behind every task",
    body: "Each task opens one editable Markdown document with real Git history — actual commits, a diff, and a restore that works. Not a notes field.",
  },
  {
    title: "Your assistant, not ours",
    body: "Symplist publishes its tools over MCP with an OAuth consent screen. Point Claude Desktop, Claude Code or any MCP client at it and it reads and edits your list alongside your real shell. We never hold a model key.",
  },
  {
    title: "Labels, when you want them",
    body: "Your own word for a slice of your list, with a colour. Filter by one, narrow with a second. An account with no labels never sees them.",
  },
  {
    title: "Time that stays calm",
    body: "Optional deadlines, a calendar, quiet hours and snooze. A date never moves a task between lists by itself.",
  },
  {
    title: "A vault with its own key",
    body: "Sensitive notes and keys sit behind a separate passphrase that ordinary sign-in does not unlock, with recovery through a fresh email code.",
  },
  {
    title: "Yours to run",
    body: "MIT licensed and self-hostable end to end. The template boots on local SQLite with no Cloudflare, Resend or Trigger account at all.",
  },
];

export function HomeScreen() {
  return (
    <div className="sym-site">
      <SiteHeader />
      <main>
        <section className="sym-hero">
          <p className="sym-hero-eyebrow">Open source · MIT · Free</p>
          <h1 className="sym-hero-title">The most productive thing is often the most simple.</h1>
          <p className="sym-hero-lede">
            Symplist is a calm task workspace. Three lists, and one real document behind every task.
            No streaks, no scores, no productivity theatre — and no assistant of ours reading over
            your shoulder.
          </p>
          <div className="sym-hero-actions">
            <Link href={SITE.app} className="sym-hero-primary">
              Open Symplist
            </Link>
            <a
              href={SITE.github}
              rel="noreferrer noopener"
              target="_blank"
              className="sym-hero-secondary"
            >
              Read the source
            </a>
          </div>
          <p className="sym-hero-fine">
            Free, with no paid tier to graduate to. Sign in with an email code — no password to
            forget.
          </p>
        </section>

        <section className="sym-lists" aria-labelledby="sym-lists-heading">
          <h2 id="sym-lists-heading">Three lists. That is the whole model.</h2>
          <ul>
            {lists.map((list) => (
              <li key={list.name}>
                <span className="sym-list-name">
                  <SymplistMark className="sym-list-mark" />
                  {list.name}
                </span>
                <p>{list.body}</p>
              </li>
            ))}
          </ul>
          <p className="sym-lists-note">
            Completing a task sends it to the archive with its page and history intact. Nothing is
            deleted because you finished it.
          </p>
        </section>

        <section className="sym-features" aria-labelledby="sym-features-heading">
          <h2 id="sym-features-heading">What you get</h2>
          <div className="sym-feature-grid">
            {features.map((feature) => (
              <article key={feature.title}>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="sym-honest" aria-labelledby="sym-honest-heading">
          <h2 id="sym-honest-heading">What we will say plainly</h2>
          <dl>
            <div>
              <dt>Your content is encrypted at rest.</dt>
              <dd>
                Task titles, documents, labels and vault entries are encrypted before they are
                stored. Your email address is not — it is how you sign in.
              </dd>
            </div>
            <div>
              <dt>It is not end-to-end encryption.</dt>
              <dd>
                The service holds the keys and can read your content to provide the features you ask
                for. Anyone claiming otherwise about a product like this is selling you something.
              </dd>
            </div>
            <div>
              <dt>Analytics is off until you say yes.</dt>
              <dd>
                No session recording, no advertising trackers, and no task or document text ever
                reaches it. You can decline as easily as accept.
              </dd>
            </div>
            <div>
              <dt>It is free, and there is no plan above it.</dt>
              <dd>
                No billing, no quotas, no feature held back. If that ever has to change, it will
                change in the open, in this repository.
              </dd>
            </div>
          </dl>
        </section>

        <AskYourAi />

        <section className="sym-closing" aria-labelledby="sym-closing-heading">
          <h2 id="sym-closing-heading">Start with one task.</h2>
          <p>
            No invite, no waitlist, no card. Sign in with your email and add the thing you have been
            carrying around all week.
          </p>
          <Link href={SITE.app} className="sym-hero-primary">
            Open Symplist
          </Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
