import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { APPEARANCE_COOKIE, parseAppearanceCookie } from "@/theme/appearance";

/**
 * The signed-in workspace, settings and administration, inside the app shell. It reads only the
 * non-sensitive appearance cookie, so the framed panels open at the sample's widths for the theme
 * that renders on first paint (§5.1, §10.3).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const { themeId } = parseAppearanceCookie(cookieStore.get(APPEARANCE_COOKIE)?.value);
  return <AppShell themeId={themeId}>{children}</AppShell>;
}
