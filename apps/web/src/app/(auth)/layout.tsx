import type { ReactNode } from "react";
import { SignInFlowProvider } from "@/features/access/signin/flow";

/**
 * Sign-in, account creation and email verification. Analytics never loads here (§15). The flow
 * provider keeps the address across the three steps, so moving between them never loses it.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return <SignInFlowProvider>{children}</SignInFlowProvider>;
}
