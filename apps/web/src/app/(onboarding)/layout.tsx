import type { ReactNode } from "react";
import { SessionGate } from "@/features/access/session";

/** First-run name and connection steps; they need a session, and each step guards its own state. */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <SessionGate require="identity">{children}</SessionGate>;
}
