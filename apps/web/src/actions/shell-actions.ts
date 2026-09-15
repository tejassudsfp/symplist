import type { ActionAvailability, ActionEnvironment, AppAction } from "./types.ts";

/**
 * The action id the access feature registers for signing out. The profile menu invokes it through the
 * registry, so sign-out runs the same checks from every entry point (§10.2).
 */
export const SIGN_OUT_ACTION_ID = "access.sign_out";

const enabled: ActionAvailability = { enabled: true };

function needsTask(environment: ActionEnvironment): ActionAvailability {
  return environment.services.route?.taskId
    ? enabled
    : { enabled: false, reason: "Open a task first" };
}

function needsShell(environment: ActionEnvironment): ActionAvailability {
  return environment.services.shell
    ? enabled
    : { enabled: false, reason: "Available in the task workspace" };
}

function navigation(
  id: string,
  label: string,
  href: string,
  binding: string,
  keywords: string[],
): AppAction {
  return {
    id,
    label,
    context: "app",
    group: "navigation",
    keywords,
    defaultBinding: binding,
    availability: () => enabled,
    run: ({ services }) => services.navigate(href),
  };
}

/** Shell navigation and panel actions with the note 13 bindings. */
export const shellActions: readonly AppAction[] = [
  navigation("shell.go_now", "Go to Now", "/now", "g n", ["collection", "today"]),
  navigation("shell.go_later", "Go to Later", "/later", "g l", ["collection", "someday"]),
  navigation("shell.go_unclassified", "Go to Unclassified", "/unclassified", "g u", [
    "collection",
    "inbox",
  ]),
  navigation("shell.go_archive", "Open archive", "/archive", "g a", ["completed", "restore"]),
  navigation("shell.go_settings", "Open settings", "/settings/account", "g s", ["preferences"]),
  {
    id: "shell.go_vault",
    label: "Open vault",
    context: "app",
    group: "navigation",
    keywords: ["secrets", "passwords"],
    defaultBinding: "g v",
    availability: () => enabled,
    // The Vault is an excluded route group: always a full document navigation (§15). Unlock is still
    // required there; this never bypasses it.
    run: ({ services }) => services.assign("/vault"),
  },
  {
    id: "shell.focus_inbox",
    label: "Focus task list",
    context: "app",
    group: "navigation",
    defaultBinding: "g i",
    availability: needsShell,
    run: ({ services }) => services.shell?.focusPane("inbox"),
  },
  {
    id: "shell.focus_page",
    label: "Open task page",
    context: "app",
    group: "navigation",
    defaultBinding: "g d",
    availability: (environment) => {
      const shell = needsShell(environment);
      return shell.enabled ? needsTask(environment) : shell;
    },
    run: ({ services }) => services.shell?.focusPane("page"),
  },
  {
    id: "shell.focus_chat",
    label: "Open Simon chat",
    context: "app",
    group: "navigation",
    keywords: ["simon", "assistant"],
    defaultBinding: "g c",
    availability: (environment) => {
      const shell = needsShell(environment);
      return shell.enabled ? needsTask(environment) : shell;
    },
    run: ({ services }) => services.shell?.focusPane("chat"),
  },
  {
    id: "shell.toggle_inbox",
    label: "Show or hide task list",
    context: "app",
    group: "general",
    availability: needsShell,
    run: ({ services }) => services.shell?.toggleInbox(),
  },
  {
    id: "shell.toggle_chat",
    label: "Show or hide chat",
    context: "app",
    group: "general",
    availability: (environment) => {
      const shell = needsShell(environment);
      return shell.enabled ? needsTask(environment) : shell;
    },
    run: ({ services }) => services.shell?.toggleChat(),
  },
];
