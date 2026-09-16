import type { ReactNode } from "react";
import { AdminFrame } from "@/features/access/admin/ui";
import { SessionGate } from "@/features/access/session";

/**
 * Beta administration (admin_invites.md): only accounts with the administrator role reach these
 * pages, and nothing in an ordinary person's menus links here. The api checks the role again on every
 * request with a fresh read (§5.4), so this gate decides what renders, never what is allowed.
 */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate require="admin">
      <AdminFrame>{children}</AdminFrame>
    </SessionGate>
  );
}
