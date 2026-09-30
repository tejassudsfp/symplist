import { ArrowUpRight, Sparkles } from "lucide-react";
import { SITE_URL } from "./site-chrome";

/**
 * "Ask your assistant about Symplist" — the one piece of marketing this product can make honestly.
 *
 * Every other app that ships this section is asking you to trust a summary of itself. Symplist can
 * point an assistant at `llms.txt` and its own MCP endpoint and let it answer, which is the same claim
 * the rest of the page makes: the assistant is yours, not ours.
 *
 * The marks are deliberately neutral rather than each vendor's logo. Reproducing a brand mark from
 * memory gets it subtly wrong, and a wrong logo reads worse than none — swap in the official SVGs if
 * you want them, with whatever brand permission each vendor asks for.
 */

const PROMPT = `What is Symplist (${SITE_URL})? Read ${SITE_URL}/llms.txt and tell me what it does, what it costs, and how I connect my own assistant to it over MCP.`;

const assistants = [
  { name: "ChatGPT", href: `https://chatgpt.com/?q=${encodeURIComponent(PROMPT)}` },
  { name: "Claude", href: `https://claude.ai/new?q=${encodeURIComponent(PROMPT)}` },
  {
    name: "Perplexity",
    href: `https://www.perplexity.ai/search?q=${encodeURIComponent(PROMPT)}`,
  },
];

export function AskYourAi() {
  return (
    <section className="sym-ask" aria-labelledby="sym-ask-heading">
      <h2 id="sym-ask-heading">
        <Sparkles size={18} strokeWidth={2} aria-hidden="true" className="sym-ask-spark" />
        Ask your assistant about Symplist
      </h2>
      <p>
        Don&rsquo;t take our word for any of this. Symplist publishes{" "}
        <a href="/llms.txt">llms.txt</a> — what it is, what it stores, what it costs and every tool
        it exposes — so an assistant can read it and answer you directly.
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
            <span className="sym-ask-mark" aria-hidden="true" />
            {assistant.name}
            <ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />
          </a>
        ))}
      </div>
      <p className="sym-ask-fine">
        Once you have an account, the same assistants can connect to your actual list over MCP and
        read and edit it alongside your real shell — with a consent screen you approve and access
        you can revoke.
      </p>
    </section>
  );
}
