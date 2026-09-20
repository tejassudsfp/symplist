/** Where an action applies. Dispatch precedence: modal or menu, then editor or composer, then the focused pane, then the app (§10.2). */
export type ActionContext = "modal" | "menu" | "editor" | "composer" | "pane" | "app";

/** Workspace panes that can hold focus (inbox list, task page, chat). */
export type PaneId = "inbox" | "page" | "chat";

/** How an action was invoked. Every source runs the same action and the same availability check. */
export type ActionSource = "keyboard" | "pointer" | "menu" | "palette";

/** Operating-system family used for `Mod` and key labels (note 13). */
export type Platform = "mac" | "other";

/** Groups in the shortcut reference (keyboard_shortcuts.md). */
export type ActionGroup = "navigation" | "tasks" | "page" | "chat" | "search" | "general";

/** Whether an action can run now, with the reason shown when it cannot. */
export interface ActionAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

/** A workspace route: a collection and, when a task is open, its id. */
export interface WorkspaceRoute {
  readonly collection: "now" | "later" | "unclassified";
  readonly taskId: string | null;
}

/** Imperative controls the app shell exposes to actions (panels and pane focus). */
export interface ShellController {
  focusPane(pane: PaneId): void;
  /**
   * Shows the task list (expanding it, opening the laptop drawer, or waiting for a pending navigation
   * to reach the phone's list view) and focuses its heading once it is visible. Collection shortcuts
   * call it after navigating, so `g` then `l` opens Later and focuses its list (note 13).
   */
  revealInbox(): void;
  toggleInbox(): void;
  toggleChat(): void;
  isInboxVisible(): boolean;
  isChatVisible(): boolean;
}

/** Runtime services an action may use; provided by the app shell. */
export interface ActionServices {
  /** Client-side navigation inside the signed-in app. */
  navigate(href: string): void;
  /** Full document navigation, required when entering an excluded route group (§15). */
  assign(href: string): void;
  /** Polite status announcement for screen readers. */
  announce(message: string): void;
  readonly route: WorkspaceRoute | null;
  readonly shell: ShellController | null;
}

/** Everything an action sees when it is checked or run. */
export interface ActionEnvironment {
  readonly source: ActionSource;
  readonly platform: Platform;
  /** The pane that held focus at invocation, if any. */
  readonly pane: PaneId | null;
  readonly services: ActionServices;
}

/** One command. Buttons, menus, the command palette and shortcuts all invoke the same action. */
export interface AppAction {
  readonly id: string;
  readonly label: string;
  readonly context: ActionContext;
  /** For `pane` actions: the pane that must hold focus. Omitted means any pane. */
  readonly pane?: PaneId;
  readonly group?: ActionGroup;
  /** Extra palette search terms. */
  readonly keywords?: readonly string[];
  readonly availability: (environment: ActionEnvironment) => ActionAvailability;
  readonly run: (environment: ActionEnvironment) => void | Promise<void>;
  /**
   * Default key binding from note 13 in canonical form, for example `mod+k`, `shift+n`, `?` or the
   * sequence `g c`; users can remap it.
   */
  readonly defaultBinding?: string;
  /**
   * Held-key repeat. Off by default so create, complete and send never repeat; navigation actions
   * such as next and previous task opt in (note 13).
   */
  readonly allowRepeat?: boolean;
}
