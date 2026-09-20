"use client";

// Adapted from Vercel AI Elements. Copyright 2023 Vercel, Inc. Apache-2.0; see LICENSE.
import { cn } from "cn";
import { ArrowDownIcon } from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";

export function Conversation({ className, ...props }: ComponentProps<typeof StickToBottom>) {
  const [reduceMotion, setReduceMotion] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduceMotion(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return (
    <StickToBottom
      {...props}
      role="log"
      aria-label="Conversation with Simon"
      initial="instant"
      resize={reduceMotion ? "instant" : "smooth"}
      className={cn("relative min-h-0 flex-1 overflow-y-hidden", className)}
    />
  );
}

export function ConversationContent({
  className,
  ...props
}: ComponentProps<typeof StickToBottom.Content>) {
  return (
    <StickToBottom.Content
      {...props}
      className={cn("flex min-h-full flex-col gap-4 px-3.5 pt-3.5 pb-2", className)}
    />
  );
}

export function ConversationScrollButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  return !isAtBottom ? (
    <Button
      className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full"
      size="icon"
      variant="secondary"
      aria-label="Go to newest message"
      onClick={() => void scrollToBottom({ animation: "instant" })}
    >
      <ArrowDownIcon size={16} aria-hidden="true" />
    </Button>
  ) : null;
}
