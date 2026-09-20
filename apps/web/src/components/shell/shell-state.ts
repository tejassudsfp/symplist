import type { WorkspaceRoute } from "@/actions/types";

/** Shell layout modes, matching the sample's 1440, 1024 and 390 px frames. */
export type LayoutMode = "desktop" | "laptop" | "mobile";

export const DESKTOP_MIN_WIDTH = 1280;
export const MOBILE_MAX_WIDTH = 767;

export const INBOX_SIZE = { min: 240, default: 280, max: 400 } as const;
export const CHAT_SIZE = { min: 300, default: 340, max: 480 } as const;
export const PAGE_MIN_SIZE = 360;

export interface PanelSizeRange {
  readonly min: number;
  readonly default: number;
  readonly max: number;
}

/**
 * The horizontal space a theme's panel inset (a CSS margin shorthand of px lengths, for example
 * `12px 12px 12px 0`) takes beside a framed panel: left plus right.
 */
export function horizontalInset(shorthand: string): number {
  const lengths = shorthand
    .trim()
    .split(/\s+/)
    .map((part) => {
      const match = /^(\d+(?:\.\d+)?)(?:px)?$/.exec(part);
      return match?.[1] ? Number(match[1]) : 0;
    });
  const [top = 0, right = top, , left = right] = lengths;
  return right + left;
}

/**
 * Desktop panel sizes for a theme. The sample draws the task list at 280 px and the chat at 340 px
 * and floats inset themes' panels with a margin around them, so a framed panel slot is its panel
 * width plus the inset; the resize limits (task list 240–400, chat 300–480) apply to the panel
 * itself.
 */
export function panelSizes(panelInset: string): {
  readonly inbox: PanelSizeRange;
  readonly chat: PanelSizeRange;
} {
  const inset = horizontalInset(panelInset);
  const widen = (range: PanelSizeRange): PanelSizeRange => ({
    min: range.min + inset,
    default: range.default + inset,
    max: range.max + inset,
  });
  return { inbox: widen(INBOX_SIZE), chat: widen(CHAT_SIZE) };
}

export interface ShellState {
  /** Desktop: the task list panel is collapsed to the rail's "Show task list" control. */
  readonly inboxCollapsed: boolean;
  /** Desktop and laptop: the chat is collapsed to the corner control. */
  readonly chatCollapsed: boolean;
  /** Laptop: the task list floats over the page as a drawer. */
  readonly drawerOpen: boolean;
  /** Mobile, on a task route: which single surface is shown. */
  readonly mobileView: "page" | "chat";
  readonly route: WorkspaceRoute;
}

export type ShellEvent =
  | { readonly type: "route"; readonly route: WorkspaceRoute }
  | { readonly type: "set-inbox-collapsed"; readonly collapsed: boolean }
  | { readonly type: "set-chat-collapsed"; readonly collapsed: boolean }
  | { readonly type: "set-drawer"; readonly open: boolean }
  | { readonly type: "show"; readonly view: "page" | "chat" };

export function initialShellState(route: WorkspaceRoute): ShellState {
  return {
    inboxCollapsed: false,
    chatCollapsed: false,
    // The 1024 frame opens the drawer when no task is selected and keeps it closed on a task.
    drawerOpen: route.taskId === null,
    mobileView: "page",
    route,
  };
}

export function shellReducer(state: ShellState, event: ShellEvent): ShellState {
  switch (event.type) {
    case "route": {
      const { route } = event;
      if (route.collection === state.route.collection && route.taskId === state.route.taskId) {
        return state;
      }
      const taskChanged = route.taskId !== state.route.taskId;
      return {
        ...state,
        route,
        // Selecting a task closes the drawer; opening a collection shows its list.
        drawerOpen: route.taskId === null,
        mobileView: taskChanged ? "page" : state.mobileView,
      };
    }
    case "set-inbox-collapsed":
      return state.inboxCollapsed === event.collapsed
        ? state
        : { ...state, inboxCollapsed: event.collapsed };
    case "set-chat-collapsed":
      return state.chatCollapsed === event.collapsed
        ? state
        : { ...state, chatCollapsed: event.collapsed };
    case "set-drawer":
      return state.drawerOpen === event.open ? state : { ...state, drawerOpen: event.open };
    case "show":
      return state.mobileView === event.view ? state : { ...state, mobileView: event.view };
  }
}

/** Whether the task list is visible in a layout mode. */
export function isInboxVisible(state: ShellState, mode: LayoutMode): boolean {
  if (mode === "desktop") return !state.inboxCollapsed;
  if (mode === "laptop") return state.drawerOpen;
  return state.route.taskId === null;
}

/** Whether the chat panel is visible in a layout mode. */
export function isChatVisible(state: ShellState, mode: LayoutMode): boolean {
  if (state.route.taskId === null) return false;
  if (mode === "mobile") return state.mobileView === "chat";
  return !state.chatCollapsed;
}
