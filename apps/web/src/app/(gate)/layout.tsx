import type { ReactNode } from "react";
import { SessionGate } from "@/features/access/session";

/**
 * The beta access gate, paused access and the restricted account screen. Every route here needs a
 * session but not admission (§5.4 `identity`), and analytics never loads in this group (§15).
 */
export default function GateLayout({ children }: { children: ReactNode }) {
  return <SessionGate require="identity">{children}</SessionGate>;
}
