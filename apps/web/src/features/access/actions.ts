import { SIGN_OUT_ACTION_ID } from "@/actions/shell-actions";
import type { AppAction } from "@/actions/types";
import { signOutOfBrowser } from "./session-runtime.ts";

/**
 * Actions contributed by the access feature to the command registry (§10.2). Sign-out runs the same
 * way from the profile menu, a settings button or a shortcut: it ends the session at the api, clears
 * the appearance cookie and the analytics identity (decision W4, §15), and loads the email entry as a
 * new document so no protected content stays in memory.
 */
export const accessActions: readonly AppAction[] = [
  {
    id: SIGN_OUT_ACTION_ID,
    label: "Sign out",
    context: "app",
    group: "general",
    keywords: ["log out", "leave", "switch account"],
    availability: () => ({ enabled: true }),
    run: async () => {
      const outcome = await signOutOfBrowser();
      // The dispatcher announces a failure; the sign-out feedback offers the retry.
      if (outcome === "failed") throw new Error("sign_out_failed");
    },
  },
];
