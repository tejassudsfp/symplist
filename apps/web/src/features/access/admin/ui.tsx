"use client";

import { cn } from "cn";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { SkeletonLines } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { AccessProblem } from "../errors.ts";
import { genericProblemMessage } from "../errors.ts";

/** The three administration sections (admin_invites.md). Ordinary menus never link here. */
export const adminSections = [
  { href: "/admin/invites", label: "Invites" },
  { href: "/admin/accounts", label: "Accounts" },
  { href: "/admin/activity", label: "Activity" },
] as const;

/** The compact Beta administration shell, rendered inside the app frame. */
export function AdminFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-7 md:px-8">
      <div className="flex flex-col gap-3">
        <Link
          href="/now"
          className="text-[13px] text-sym-muted underline-offset-2 hover:text-sym-text hover:underline"
        >
          ← Back to workspace
        </Link>
        <nav aria-label="Beta administration">
          <ul className="m-0 flex list-none gap-1 p-0">
            {adminSections.map((section) => {
              const active = pathname.startsWith(section.href);
              return (
                <li key={section.href}>
                  <Link
                    href={section.href}
                    {...(active ? { "aria-current": "page" as const } : {})}
                    className={cn(
                      "block rounded-sym px-2.5 py-1.5 text-[13.5px] text-sym-muted hover:bg-sym-hover hover:text-sym-text",
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
      </div>
      {children}
    </div>
  );
}

export function AdminHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 font-heading font-semibold text-[20px] tracking-[-0.01em]">{title}</h1>
        {description ? (
          <p className="m-0 text-[13.5px] text-sym-muted [text-wrap:pretty]">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/** A row of exclusive filters, each a button so the list reloads without a page change. */
export function FilterChips<Value extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "cursor-pointer rounded-sym border px-2.5 py-1 text-[13px]",
              active
                ? "border-sym-line-strong bg-sym-hover font-medium text-sym-text"
                : "border-sym-line bg-sym-surface text-sym-muted hover:text-sym-text",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}

/** Region-level loading for a list, never a whole-page spinner (system_states.md). */
export function AdminLoading({ label }: { label: string }) {
  return <SkeletonLines label={label} widths={["70%", "55%", "62%", "48%"]} />;
}

export function AdminFailed({
  problem,
  onRetry,
  title,
}: {
  problem: AccessProblem;
  onRetry: () => void;
  title: string;
}) {
  return (
    <div role="alert" className="rounded-sym-lg border border-sym-line bg-sym-surface p-4">
      <p className="m-0 font-medium">{title}</p>
      <p className="m-0 mt-1 mb-3 text-[13px] text-sym-muted">{genericProblemMessage(problem)}</p>
      <Button size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function AdminEmpty({ title, description }: { title: string; description?: ReactNode }) {
  return (
    <div className="rounded-sym-lg border border-sym-line border-dashed px-4 py-8 text-center">
      <p className="m-0 font-medium text-[14px]">{title}</p>
      {description ? (
        <p className="m-0 mx-auto mt-1 max-w-[380px] text-[13px] text-sym-muted [text-wrap:pretty]">
          {description}
        </p>
      ) : null}
    </div>
  );
}

/** "Load more" for cursor pagination; the cursor is opaque and never parsed. */
export function LoadMore({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <div className="flex justify-center">
      <Button size="md" disabled={busy} aria-busy={busy || undefined} onClick={onClick}>
        {busy ? <Spinner size={11} /> : null}
        {busy ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}

/**
 * One responsive data table: columns on wide screens, stacked labelled rows on phones, from the same
 * markup, so nothing is duplicated for assistive technology (admin_invites.md).
 */
export function DataTable({ className, ...props }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table
        className={cn("w-full border-collapse text-left text-[13.5px]", className)}
        {...props}
      />
    </div>
  );
}

export function HeadCell({ className, ...props }: ComponentProps<"th">) {
  return (
    <th
      scope="col"
      className={cn(
        "hidden border-sym-line border-b px-2 py-2 font-medium text-[12.5px] text-sym-muted md:table-cell",
        className,
      )}
      {...props}
    />
  );
}

export function Row({ className, ...props }: ComponentProps<"tr">) {
  return (
    <tr
      className={cn(
        "block border-sym-line border-b last:border-0 md:table-row",
        "[&>td]:block [&>td]:px-2 [&>td]:py-1 md:[&>td]:table-cell md:[&>td]:py-2.5",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A cell that names itself on phones: `label` is shown before the value in the stacked layout and
 * comes from the column header on wide screens.
 */
export function Cell({
  label,
  className,
  children,
  ...props
}: ComponentProps<"td"> & { label: string }) {
  return (
    <td className={cn("align-top first:pt-3 last:pb-3 md:first:pt-2.5", className)} {...props}>
      <span className="mr-2 inline-block min-w-[96px] text-[12px] text-sym-muted md:hidden">
        {label}
      </span>
      {children}
    </td>
  );
}
