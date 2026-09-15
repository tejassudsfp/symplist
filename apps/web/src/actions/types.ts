/** Where an action applies. Dispatch precedence: modal or menu, then editor or composer, then the focused pane, then the app (§10.2). */
export type ActionContext = "modal" | "menu" | "editor" | "composer" | "pane" | "app";

/** Whether an action can run now, with the reason shown when it cannot. */
export interface ActionAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
}

/** One command. Buttons, menus, the command palette and shortcuts all invoke the same action. */
export interface AppAction {
  readonly id: string;
  readonly label: string;
  readonly context: ActionContext;
  readonly availability: () => ActionAvailability;
  readonly run: () => void | Promise<void>;
  /** Default key binding from note 13, for example `mod+k`; users can remap it. */
  readonly defaultBinding?: string;
}
