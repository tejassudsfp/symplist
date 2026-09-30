import type { Metadata } from "next";
import { VaultQuickAccess } from "@/features/vault/quick-access";

/**
 * The desktop shell's Vault quick-access panel (`apps/desktop/src/main/vault-window.ts` loads this
 * path in its own small window). It is deliberately outside the `(vault)` group: `SessionGate` would
 * redirect a signed-out visitor into the full sign-in flow, and a 320 px panel renders its own notice
 * and sends the person to the main window instead.
 */
export const metadata: Metadata = {
  title: "Vault",
  robots: { index: false, follow: false, nocache: true },
};

export default function VaultQuickAccessPage() {
  return <VaultQuickAccess />;
}
