"use client";

import { CSPProvider } from "@base-ui/react/csp-provider";
import type { ReactNode } from "react";
import { StatusAnnouncerProvider } from "@/components/ui/status-announcer";
import { ToastProvider } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SessionProvider } from "@/features/access/session";

/**
 * Providers every route needs: the CSP nonce for Base UI's inline elements, the status announcer,
 * the single toast region, shared tooltip timing and the session (access feature).
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
          <TooltipProvider>
            <SessionProvider>{children}</SessionProvider>
          </TooltipProvider>
        </ToastProvider>
      </StatusAnnouncerProvider>
    </CSPProvider>
  );
}
