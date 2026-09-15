"use client";

import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ReactNode } from "react";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * Providers every route needs: the CSP nonce for Base UI's inline elements, the status announcer,
 * the single toast region and shared tooltip timing.
 */
export function AppProviders({
  nonce,
  children,
}: {
  nonce: string | undefined;
  children: ReactNode;
}) {
  return (
    <CSPProvider {...(nonce ? { nonce } : {})}>
      <StatusAnnouncerProvider>
        <ToastProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ToastProvider>
      </StatusAnnouncerProvider>
    </CSPProvider>
  );
}
