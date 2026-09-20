import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { FeatureSlots } from "@/components/shell/feature-slots";
import { SessionGate } from "@/features/access/session";
import { APPEARANCE_COOKIE, parseAppearanceCookie } from "@/theme/appearance";

/**
 * The signed-in workspace, settings and administration, inside the app shell. Every route here needs
 * an admitted account (§5.4), and each feature's seam component plugs into the shell through
 * `FeatureSlots` (§2.3). It reads only the non-sensitive appearance cookie, so the framed panels open
 * at the sample's widths for the theme that renders on first paint (§5.1, §10.3).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const { themeId } = parseAppearanceCookie(cookieStore.get(APPEARANCE_COOKIE)?.value);
  return (
    <SessionGate require="admitted">
      <FeatureSlots>
        <AppShell themeId={themeId}>{children}</AppShell>
      </FeatureSlots>
    </SessionGate>
  );
}
