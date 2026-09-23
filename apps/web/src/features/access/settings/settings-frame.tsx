"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface SettingsSection {
  readonly href: string;
  readonly label: string;
}

/** The Settings sections (settings_account.md). There is no Billing section in the beta. */
export const settingsSections: readonly SettingsSection[] = [
  { href: "/settings/account", label: "Account" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/shortcuts", label: "Keyboard shortcuts" },
  { href: "/settings/models", label: "Models" },
  { href: "/settings/connections", label: "Connections" },
  { href: "/settings/agents", label: "Agent connections" },
  { href: "/settings/about", label: "About" },
];

/**
 * The modest Settings shell: a section list beside the content on wide screens, a scrollable selector
 * on phones, and a way back to the workspace. Each settings page renders its own content inside it.
 */
export function SettingsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-5 py-8 md:flex-row md:gap-10 md:px-8">
      <nav aria-label="Settings" className="flex flex-none flex-col gap-3 md:w-[188px]">
        <Link
          href="/now"
          className="text-[13px] text-sym-muted underline-offset-2 hover:text-sym-text hover:underline"
        >
          ← Back to workspace
        </Link>
        <ul className="-mx-1 m-0 flex list-none gap-1 overflow-x-auto p-0 md:mx-0 md:flex-col md:overflow-visible">
          {settingsSections.map((section) => {
            const active = pathname === section.href;
            return (
              <li key={section.href} className="flex-none">
                <Link
                  href={section.href}
                  {...(active ? { "aria-current": "page" as const } : {})}
                  className={cn(
                    "block whitespace-nowrap rounded-sym px-2.5 py-1.5 text-[13.5px] text-sym-muted hover:bg-sym-hover hover:text-sym-text",
                    active && "bg-sym-hover font-medium text-sym-text",
                  )}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-7">{children}</div>
    </div>
  );
}
