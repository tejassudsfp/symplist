"use client";

// Adapted from Vercel AI Elements. Copyright 2023 Vercel, Inc. Apache-2.0; see LICENSE.
import { cn } from "cn";
import type { ComponentProps } from "react";
import { SafeMarkdown } from "@/components/markdown/safe-markdown";

export function Message({
  from,
  className,
  ...props
}: ComponentProps<"div"> & { from: "user" | "assistant" | "tool" }) {
  return (
    <div
      {...props}
      data-from={from}
      className={cn(
        "sym-chat-message group flex min-w-0 flex-col gap-1.5",
        from === "user" ? "is-user ml-auto max-w-[92%]" : "is-assistant w-full",
        className,
      )}
    />
  );
}

export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={cn(
        "sym-chat-message-content min-w-0 text-[13.5px] leading-[1.55] [overflow-wrap:anywhere] group-[.is-user]:rounded-sym group-[.is-user]:bg-sym-hover group-[.is-user]:px-3 group-[.is-user]:py-2",
        className,
      )}
    />
  );
}

export function MessageResponse({ children }: { children: string }) {
  return <SafeMarkdown source={children} headingLevelStart={4} className="sym-chat-response" />;
}
