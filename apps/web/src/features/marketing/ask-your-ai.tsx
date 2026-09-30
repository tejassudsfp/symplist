import { SITE_URL } from "./site-chrome";

/**
 * "Ask your assistant about Symplist" — the one piece of marketing this product can make honestly.
 *
 * Every other site shipping this section asks you to trust its summary of itself. Symplist points an
 * assistant at its own `llms.txt` and lets it answer, which is the same claim the rest of the page
 * makes: the assistant is yours, not ours.
 */

const PROMPT = `I'm looking at Symplist (${SITE_URL}), an open-source task workspace.

Please read ${SITE_URL}/llms.txt and explain, in plain language:
1. What Symplist is and how the three lists work
2. What it stores, what it encrypts, and what it does not claim
3. What it costs
4. How I connect my own assistant to it over MCP

Cite the symplist.app pages you use.`;

const q = encodeURIComponent(PROMPT);

/**
 * Single-colour marks are masked so they take the theme's text colour and read in light and dark;
 * the full-colour ones are drawn as images because their colour is the brand.
 */
const assistants = [
  {
    name: "ChatGPT",
    href: `https://chatgpt.com/?hints=search&q=${q}`,
    icon: "openai.svg",
    mono: true,
  },
  { name: "Claude", href: `https://claude.ai/new?q=${q}`, icon: "claude-color.svg" },
  { name: "Gemini", href: `https://www.google.com/search?udm=50&q=${q}`, icon: "gemini-color.svg" },
  {
    name: "Perplexity",
    href: `https://www.perplexity.ai/search/new?q=${q}`,
    icon: "perplexity-color.svg",
  },
  { name: "Grok", href: `https://grok.com/?q=${q}`, icon: "grok.svg", mono: true },
  { name: "Copilot", href: `https://copilot.microsoft.com/?q=${q}`, icon: "copilot-color.svg" },
];

const steps = [
  {
    title: "Add Symplist to your client",
    body: "Register it as an MCP server in Claude Desktop, Claude Code or any client that speaks MCP.",
  },
  {
    title: "Approve what it can see",
    body: "A consent screen shows the tools requested. Scope the grant to specific tasks if you like.",
  },
  {
    title: "Revoke whenever",
    body: "Every grant is listed in Settings, and removing one takes effect immediately.",
  },
];

function Mark({ icon, mono }: { readonly icon: string; readonly mono?: boolean }) {
  const src = `/ai/${icon}`;
  if (mono) {
    return (
      <span
        aria-hidden="true"
        className="sym-ask-icon sym-ask-icon--mono"
        style={{
          mask: `url(${src}) center / contain no-repeat`,
          WebkitMask: `url(${src}) center / contain no-repeat`,
        }}
      />
    );
  }
  // biome-ignore lint/performance/noImgElement: a 15px brand mark needs no optimisation pipeline.
  return <img src={src} alt="" aria-hidden="true" className="sym-ask-icon" />;
}

export function AskYourAi() {
  return (
    <section id="assistant" className="sym-section" aria-labelledby="sym-assistant-heading">
      <div className="sym-split sym-assistant-panel">
        <div>
          <p className="sym-eyebrow">Assistants</p>
          <h2 id="sym-assistant-heading" className="sym-display">
            Bring your own. We don&rsquo;t run one.
          </h2>
          <p className="sym-section-lede">
            Symplist publishes 20 scoped tools over MCP. Claude Desktop, Claude Code or any MCP
            client can read and edit your tasks next to your real shell and repository. Your model
            key stays with your client.
          </p>
          <div className="sym-ask-row">
            {assistants.map((assistant) => (
              <a
                key={assistant.name}
                href={assistant.href}
                rel="noreferrer noopener"
                target="_blank"
                className="sym-ask-button"
              >
                <Mark icon={assistant.icon} {...(assistant.mono ? { mono: true } : {})} />
                {`Ask ${assistant.name}`}
                <span aria-hidden="true" className="sym-ask-arrow">
                  ↗
                </span>
              </a>
            ))}
          </div>
          <p className="sym-fine">
            Each link asks that assistant to read our{" "}
            <a href="/llms.txt" className="sym-fine-link">
              llms.txt
            </a>{" "}
            and explain Symplist to you. Nothing is sent to us.
          </p>
        </div>
        <ol className="sym-steps">
          {steps.map((step, index) => (
            <li key={step.title}>
              <span className="sym-step-n">{index + 1}</span>
              <div className="sym-step-text">
                <span className="sym-step-title">{step.title}</span>
                <span className="sym-step-body">{step.body}</span>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
