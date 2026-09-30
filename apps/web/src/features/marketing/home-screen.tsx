import Link from "next/link";
import { accentPresets, resolveAccent } from "@/theme/accent";
import { renderedPalette } from "@/theme/palette";
import { themeIds, themes } from "@/theme/registry";
import { AskYourAi } from "./ask-your-ai";
import { SITE, SiteFooter, SiteHeader } from "./site-chrome";

/**
 * What Symplist is, in the order a stranger needs it: the claim, the three lists, what opens up when
 * you want it, the six looks, whose assistant it uses, and what it will and will not say about your
 * data.
 *
 * One page on purpose. A product whose thesis is that the simplest thing usually wins cannot open
 * with a tour.
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
    title: "A real page, with real history",
    body: "Every task opens one editable Markdown document backed by an actual Git engine — commits, a diff, and a restore that works. Not a notes field.",
  },
  {
    title: "Labels, only if you want them",
    body: "Your own word for a slice of your list, with a colour. Filter by one, narrow with a second. An account with no labels never sees them.",
  },
  {
    title: "Time that stays quiet",
    body: "Optional deadlines, a calendar, quiet hours and snooze. A date never moves a task between lists by itself.",
  },
  {
    title: "A vault with its own key",
    body: "Sensitive notes and keys sit behind a separate passphrase that ordinary sign-in does not unlock, recoverable with a fresh email code.",
  },
  {
    title: "Keyboard first",
    body: "A command palette, contextual shortcuts you can remap, and scoped search across tasks and their documents.",
  },
  {
    title: "Yours to run",
    body: "MIT licensed and self-hostable end to end. The template boots on local SQLite with no Cloudflare, Resend or Trigger account at all.",
  },
];

const plainly = [
  {
    title: "Your content is encrypted at rest.",
    body: "Task titles, documents, labels and vault entries are encrypted before they are stored. Your email address is not — it is how you sign in.",
  },
  {
    title: "It is not end-to-end encryption.",
    body: "The service holds the keys and can read your content to provide the features you ask for. Anyone claiming otherwise about a product like this is selling you something.",
  },
  {
    title: "Analytics is off until you say yes.",
    body: "No session recording, no advertising trackers, and no task or document text ever reaches it. You can decline as easily as accept.",
  },
  {
    title: "It is free, and nothing sits above it.",
    body: "No billing, no quotas, no feature held back. If that ever has to change, it will change in the open, in this repository.",
  },
];

export function HomeScreen() {
  return (
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
              Read the source
            </a>
          </div>
          <p className="sym-fine sym-hero-fine">
            Sign in with an email code. No password, no invite, no card.
          </p>
        </section>

        <section id="product" className="sym-section" aria-labelledby="sym-model-heading">
          <p className="sym-eyebrow">The model</p>
          <h2 id="sym-model-heading">Three lists. That&rsquo;s all of it.</h2>
          <p className="sym-section-lede">
            Tasks move only when you move them. Finishing one archives it with its page and history
            intact.
          </p>
          <ul className="sym-lists">
            {lists.map((list) => (
              <li key={list.name}>
                <span className="sym-list-name">{list.name}</span>
                <p>{list.body}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="sym-section" aria-labelledby="sym-features-heading">
          <h2 id="sym-features-heading">
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
          <p className="sym-eyebrow">Appearance</p>
          <h2 id="sym-themes-heading">Six ways for it to feel like yours.</h2>
          <p className="sym-section-lede">
            Each style changes type, spacing and shape, not just colour, and comes in light and
            dark. Pick one in Settings; everything follows.
          </p>
          <ul className="sym-themes">
            {themeIds.map((id) => {
              /*
               * Real palette values, read from the registry at render time. `data-theme` cannot work
               * here: the appearance stylesheet is scoped to `:root` and only ever carries the theme
               * the visitor is actually using, so six swatches carrying the attribute all painted the
               * same colour.
               */
              const palette = renderedPalette(themes[id], "light");
              const accent = resolveAccent(accentPresets.blue.seed, themes[id], "light");
              return (
                <li key={id}>
                  <span className="sym-theme-swatches" aria-hidden="true">
                    <span
                      className="sym-theme-swatch"
                      style={{ background: palette.bg, borderColor: palette.line }}
                    />
                    <span
                      className="sym-theme-swatch"
                      style={{ background: palette.panel, borderColor: palette.line }}
                    />
                    <span
                      className="sym-theme-swatch sym-theme-swatch--alt"
                      style={{ background: accent.accent }}
                    />
                  </span>
                  <span className="sym-theme-name">{themes[id].name}</span>
                  <span className="sym-theme-tag">{themes[id].tag}</span>
                </li>
              );
            })}
          </ul>
        </section>

        <AskYourAi />

        <section className="sym-section" aria-labelledby="sym-plain-heading">
          <div className="sym-split">
            <div>
              <p className="sym-eyebrow">In plain words</p>
              <h2 id="sym-plain-heading">What we store, and what we don&rsquo;t claim.</h2>
              <p className="sym-section-lede">
                The uncomfortable parts are here rather than buried in a policy nobody opens.
              </p>
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
          <h2 id="sym-closing-heading">Start with one task.</h2>
          <p>
            Sign in with your email and write down the one thing you keep meaning to do. No invite,
            no waitlist, no card.
          </p>
          <Link href={SITE.app} className="sym-button-primary">
            Start with one task <span aria-hidden="true">→</span>
          </Link>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
