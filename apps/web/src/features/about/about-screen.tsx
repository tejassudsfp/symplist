"use client";

import { BookOpen, ExternalLink, GitFork, Keyboard, Scale } from "lucide-react";
import Link from "next/link";
import { useRef } from "react";
import { SymplistLogo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const REPOSITORY_URL = "https://github.com/tejassudsfp/symplist";
const SELF_HOSTING_URL = `${REPOSITORY_URL}/blob/main/SELF_HOSTING.md`;
const DOCUMENTATION_URL = `${REPOSITORY_URL}#readme`;
const AUTHOR_URL = "https://tejassuds.com";

export const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 Tejas Parthasarathi Sudarshan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

export interface AboutScreenProps {
  /** A deployment commit SHA. Untrusted or absent values are rendered as a local build. */
  readonly buildSha?: string;
}

/** Build identifiers are presentation only, but keep arbitrary environment text out of the page. */
export function shortBuildId(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{7,64}$/u.test(normalized) ? normalized.slice(0, 12) : null;
}

const externalLinkClass =
  "group flex min-h-11 items-start gap-3 rounded-sym border border-sym-line px-3 py-2.5 text-sym-text no-underline transition-colors hover:bg-sym-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus";

function ExternalResource({
  href,
  icon,
  title,
  description,
}: {
  readonly href: string;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={externalLinkClass}>
      <span className="mt-0.5 text-sym-muted" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 font-medium text-[13.5px]">
          {title}
          <ExternalLink className="size-3 text-sym-muted" aria-hidden="true" />
        </span>
        <span className="mt-0.5 block text-[12.5px] text-sym-muted leading-5">{description}</span>
      </span>
    </a>
  );
}

/** Settings → About: product identity, open-source terms, help and quiet build information. */
export function AboutScreen({ buildSha }: AboutScreenProps) {
  const licenseText = useRef<HTMLTextAreaElement>(null);
  const buildId = shortBuildId(buildSha);

  return (
    <div className="flex min-w-0 flex-col gap-8" data-slot="about-screen">
      <header className="flex flex-col items-start gap-4 border-b border-sym-line pb-7">
        <SymplistLogo className="text-[27px]" />
        <div className="flex max-w-[610px] flex-col gap-2">
          <h1 className="m-0 font-heading font-semibold text-[22px] tracking-[-0.015em]">
            About Symplist
          </h1>
          <blockquote className="m-0 font-heading text-[17px] text-sym-text leading-7">
            “The most productive thing is often the most simple.”
          </blockquote>
          <p className="m-0 text-[13.5px] text-sym-muted leading-6">
            A calm, personal task workspace where every task has a page and a conversation with
            Simon.
          </p>
        </div>
        <p className="m-0 text-[12.5px] text-sym-muted">
          Created by{" "}
          <a
            href={AUTHOR_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sym-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus"
          >
            Tejas Parthasarathi Sudarshan · tejassuds.com
          </a>
        </p>
      </header>

      <section aria-labelledby="open-source-title" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="open-source-title" className="m-0 font-heading font-semibold text-[15px]">
            Open source
          </h2>
          <p className="m-0 max-w-[620px] text-[13.5px] text-sym-muted leading-6">
            Symplist is MIT licensed. Self-hosting never requires a paid Symplist license; hosting,
            email, models and other services you choose may still have their own costs.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex min-h-8 items-center gap-2 rounded-sym border border-sym-line bg-sym-surface px-3 text-[13px] font-medium">
            <Scale className="size-3.5 text-sym-muted" aria-hidden="true" />
            MIT License
          </span>
          <Dialog>
            <DialogTrigger render={<Button variant="secondary" size="md" />}>
              View license
            </DialogTrigger>
            <DialogContent
              initialFocus={licenseText}
              className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[640px]"
            >
              <DialogTitle>MIT License</DialogTitle>
              <DialogDescription>
                The license shipped with this version of Symplist.
              </DialogDescription>
              <textarea
                ref={licenseText}
                aria-label="MIT License text"
                readOnly
                spellCheck={false}
                value={MIT_LICENSE_TEXT}
                className="h-[min(58dvh,520px)] w-full resize-none overflow-y-auto whitespace-pre-wrap rounded-sym border border-sym-line bg-sym-code-bg p-4 font-mono text-[12px] text-sym-text leading-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus"
              />
              <DialogActions>
                <DialogClose render={<Button variant="primary" size="lg" />}>
                  Close license
                </DialogClose>
              </DialogActions>
            </DialogContent>
          </Dialog>
        </div>

        <div data-slot="about-resources" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ExternalResource
            href={REPOSITORY_URL}
            icon={<GitFork className="size-4" />}
            title="Source repository"
            description="Read the source, report an issue or contribute."
          />
          <ExternalResource
            href={SELF_HOSTING_URL}
            icon={<BookOpen className="size-4" />}
            title="Self-hosting"
            description="Run Symplist with infrastructure and providers you control."
          />
        </div>
      </section>

      <section
        aria-labelledby="help-title"
        className="flex flex-col gap-3 border-t border-sym-line pt-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id="help-title" className="m-0 font-heading font-semibold text-[15px]">
            Help
          </h2>
          <p className="m-0 text-[13.5px] text-sym-muted leading-6">
            Press{" "}
            <kbd className="rounded-sym border border-sym-line px-1.5 py-0.5 font-mono text-[12px]">
              ?
            </kbd>{" "}
            outside an editor to open shortcut help.
          </p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-[13.5px]">
          <Link
            href="/settings/shortcuts"
            className="inline-flex min-h-10 items-center gap-2 text-sym-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus"
          >
            <Keyboard className="size-4" aria-hidden="true" />
            Keyboard settings
          </Link>
          <a
            href={DOCUMENTATION_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-10 items-center gap-2 text-sym-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sym-focus"
          >
            <BookOpen className="size-4" aria-hidden="true" />
            Project documentation
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        </div>
      </section>

      <section
        aria-labelledby="build-title"
        className="flex flex-col gap-2 border-t border-sym-line pt-5 text-[12.5px] text-sym-muted"
      >
        <h2 id="build-title" className="m-0 font-heading font-medium text-[13px] text-sym-text">
          Version
        </h2>
        <dl className="m-0 grid max-w-[340px] grid-cols-[96px_1fr] gap-x-4 gap-y-1">
          <dt>Release</dt>
          <dd className="m-0">Closed beta</dd>
          <dt>Build</dt>
          <dd className="m-0 font-mono">{buildId ?? "Local development"}</dd>
        </dl>
      </section>
    </div>
  );
}
