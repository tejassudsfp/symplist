import type { ReactNode } from "react";
import { SettingsFrame } from "@/features/access/settings/settings-frame";

/**
 * The Settings shell (settings_account.md): the section list beside the content on wide screens, the
 * scrollable selector on phones and the way back to the workspace. It lives here so every section —
 * Account, Appearance, Notifications, Keyboard shortcuts, Connections, Agent connections and About —
 * shares one shell and each page renders only its own content.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsFrame>{children}</SettingsFrame>;
}
