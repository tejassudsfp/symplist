import type { ReactNode } from "react";
import { SessionGate } from "@/features/access/session";

/** Vault setup, unlock, reset and items. Analytics never loads here (§15). */
export default function VaultLayout({ children }: { children: ReactNode }) {
  return <SessionGate require="admitted">{children}</SessionGate>;
}
