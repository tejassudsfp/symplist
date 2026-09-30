import type { Metadata } from "next";
import { LegalPage, SITE } from "@/features/marketing/site-chrome";

export const metadata: Metadata = {
  title: "Terms of use — Symplist",
  description: "The terms that apply to the hosted Symplist service.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of use" updated="1 October 2026">
      <p>
        These terms cover the hosted service at symplist.app, run by {SITE.maintainer}. The software
        itself is open source under the{" "}
        <a href={`${SITE.github}/blob/main/LICENSE`} rel="noreferrer noopener" target="_blank">
          MIT licence
        </a>
        , and if you self-host it these terms do not apply to your own deployment — the MIT licence
        does.
      </p>

      <h2>Using the service</h2>
      <p>
        You need an email address you control. You are responsible for what you put into Symplist
        and for anything done through your account. Do not use the service to break the law, to
        store other people&rsquo;s data without the right to, or to attack the service or its other
        users.
      </p>
      <p>
        You keep every right you already had in your own content. Storing it here grants only the
        narrow permission needed to run the service for you: to store it, encrypt it, index it for
        your own search, and show it back to you or to anyone you deliberately share it with.
      </p>

      <h2>Connected assistants</h2>
      <p>
        Symplist can publish your tasks and documents to an MCP client you connect, after you
        approve a consent screen that names the client and the access it asked for. That client is
        not ours. What it does with what it reads is governed by whoever makes it, and you can
        revoke its access at any time in Settings.
      </p>

      <h2>It is free, and provided as is</h2>
      <p>
        The service costs nothing and carries no paid tier. In return, it is provided{" "}
        <strong>
          &ldquo;as is&rdquo; and &ldquo;as available&rdquo;, without warranty of any kind
        </strong>
        , express or implied, including any implied warranty of merchantability, fitness for a
        particular purpose, or non-infringement. There is no uptime commitment and no support
        commitment.
      </p>
      <p>
        <strong>
          To the fullest extent the law allows, {SITE.maintainer} accepts no liability
        </strong>{" "}
        for any loss or damage arising from your use of the service — including lost data, lost
        profits, or any indirect or consequential loss — even if advised that such loss was
        possible. Where liability cannot be excluded by law, it is limited to the amount you have
        paid for the service, which is nothing.
      </p>
      <p>
        <strong>Keep your own copies of anything you cannot afford to lose.</strong> Every task page
        is Markdown and can be exported. This is a free service run by one person; treat it
        accordingly.
      </p>

      <h2>Ending it</h2>
      <p>
        You can delete your account at any time in Settings, which removes your content and the key
        that decrypts it. The service may suspend or remove an account that is breaking these terms,
        attacking the service, or putting other people&rsquo;s data at risk. The service itself may
        change or stop; if it is going to stop, notice will be given in the repository and by email
        with enough time to export.
      </p>

      <h2>Changes, and the law that applies</h2>
      <p>
        These terms may change as the service does. Material changes will be noted here with a new
        date, and the history is public in the repository. Continuing to use the service after a
        change means accepting it. These terms are governed by the laws of India, and the courts of
        Bengaluru, Karnataka have exclusive jurisdiction.
      </p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${SITE.contact}`}>{SITE.contact}</a> for anything about these terms, or{" "}
        <a href={`mailto:${SITE.securityContact}`}>{SITE.securityContact}</a> to report a
        vulnerability privately.
      </p>
    </LegalPage>
  );
}
