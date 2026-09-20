"use client";

import Link from "next/link";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  type Layout,
  type LayoutChangedMeta,
  type PanelImperativeHandle,
  type PanelSize,
  usePanelRef,
} from "react-resizable-panels";
import { ACTION_CONTEXT_ATTRIBUTE, describeFocus, PANE_ATTRIBUTE } from "@/actions/focus";
import { useOptionalActions } from "@/actions/provider";
import type { PaneId, ShellController, WorkspaceRoute } from "@/actions/types";
import { EmptyState, ThemeIllustration } from "@/components/ui/empty-state";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { HintTooltip } from "@/components/ui/tooltip";
import { DEFAULT_THEME_ID, isThemeId, type ThemeId, themes } from "@/theme/registry";
import { ChatIcon, ChevronIcon, CollectionIcon, PanelToggleIcon } from "./collection-icons.tsx";
import { type CollectionId, collectionMeta, collections } from "./routes.ts";
import {
  INBOX_SIZE,
  initialShellState,
  isChatVisible,
  isInboxVisible,
  type LayoutMode,
  PAGE_MIN_SIZE,
  panelSizes,
  shellReducer,
} from "./shell-state.ts";
import { type ShellPanelLayout, useShellSlots } from "./slots.tsx";
import { useLayoutMode } from "./use-layout-mode.ts";

export const INBOX_TITLE_ID = "sym-inbox-title";
export const CHAT_TITLE_ID = "sym-chat-title";
export const MAIN_ID = "main";
export const SHOW_LIST_ID = "sym-show-task-list";

/**
 * How another feature finds a collection's rail item — the drag-and-drop layer marks it as a drop
 * destination (workspace_later.md). It is a function rather than a class name written out at each
 * call site so that renaming the markup here is a compile error there, not a silently dead selector.
 * `shell/app-shell.test.tsx` requires the rail to keep matching it.
 */
export function railItemSelector(collection: CollectionId): string {
  return `.sym-rail-item[data-collection="${collection}"]`;
}

function focusById(id: string) {
  requestAnimationFrame(() => {
    document.getElementById(id)?.focus({ preventScroll: false });
  });
}

function RailShortcut({ actionId }: { actionId: string }) {
  const actions = useOptionalActions();
  const label = actions?.bindingLabel(actionId);
  return label ? <span aria-hidden="true">{label.display}</span> : null;
}

function IconRail({
  route,
  mode,
  inboxVisible,
  onToggleDrawer,
  onShowList,
}: {
  route: WorkspaceRoute;
  mode: LayoutMode;
  inboxVisible: boolean;
  onToggleDrawer: () => void;
  onShowList: () => void;
}) {
  return (
    <nav className="sym-rail" aria-label="Collections">
      <ul className="sym-rail-list">
        {collections.map((collection) => {
          const active = collection.id === route.collection;
          return (
            <li key={collection.id}>
              <HintTooltip
                label={collection.label}
                shortcut={<RailShortcut actionId={`shell.go_${collection.id}`} />}
              >
                <Link
                  href={collection.href}
                  className="sym-rail-item"
                  aria-label={collection.label}
                  aria-current={active ? "page" : undefined}
                  data-collection={collection.id}
                  onClick={(event) => {
                    // At laptop width the active collection's icon shows or hides its list drawer.
                    if (mode === "laptop" && active && route.taskId === null) {
                      event.preventDefault();
                      onToggleDrawer();
                    }
                  }}
                >
                  {active ? <span aria-hidden="true" className="sym-rail-marker" /> : null}
                  <CollectionIcon collection={collection.id} />
                </Link>
              </HintTooltip>
            </li>
          );
        })}
      </ul>
      <div className="sym-rail-spacer" />
      <div className="sym-rail-bottom sym-rail-show-list" data-visible={!inboxVisible}>
        {!inboxVisible ? (
          <HintTooltip label="Show task list">
            <button
              type="button"
              id={SHOW_LIST_ID}
              className="sym-rail-item"
              aria-label="Show task list"
              onClick={onShowList}
            >
              <PanelToggleIcon side="left" size={17} />
            </button>
          </HintTooltip>
        ) : null}
      </div>
    </nav>
  );
}

function CollectionMotif() {
  return (
    <span aria-hidden="true" className="sym-theme-motif">
      <span data-for="postcard" className="sym-collection-motif-stamp">
        <span />
      </span>
      <svg
        aria-hidden="true"
        data-for="meadow"
        width="12"
        height="14"
        viewBox="0 0 12 14"
        fill="none"
      >
        <path className="sym-art-ok-stroke" d="M6 13V6" strokeWidth="1.6" strokeLinecap="round" />
        <path className="sym-art-ok" d="M6 8C2.5 8 1 5.5 1 3c3 0 5 2 5 5z" />
        <path className="sym-art-ok" d="M6 10c3.5 0 5-2.5 5-5-3 0-5 2-5 5z" opacity=".7" />
      </svg>
    </span>
  );
}

function MobileCollectionTabs({ route }: { route: WorkspaceRoute }) {
  return (
    <nav className="sym-mobile-collections sym-segmented" aria-label="Collections">
      {collections.map((collection) => (
        <Link
          key={collection.id}
          href={collection.href}
          className="sym-segmented-item"
          aria-current={collection.id === route.collection ? "page" : undefined}
          aria-label={collection.label}
        >
          {collection.short}
        </Link>
      ))}
    </nav>
  );
}

function InboxFrame({ route, onHide }: { route: WorkspaceRoute; onHide: () => void }) {
  const slots = useShellSlots();
  const meta = collectionMeta(route.collection);
  return (
    <section
      className="sym-panel sym-inbox"
      aria-labelledby={INBOX_TITLE_ID}
      {...{ [PANE_ATTRIBUTE]: "inbox" }}
    >
      {route.taskId === null ? <MobileCollectionTabs route={route} /> : null}
      <div className="sym-panel-header">
        <h2 id={INBOX_TITLE_ID} className="sym-panel-title" tabIndex={-1}>
          {meta.label}
          <CollectionMotif />
        </h2>
        <HintTooltip label="Hide task list" side="bottom">
          <button
            type="button"
            className="sym-icon-button sym-desktop-only"
            aria-label="Hide task list"
            onClick={onHide}
          >
            <PanelToggleIcon side="left" />
          </button>
        </HintTooltip>
      </div>
      <div className="sym-panel-body">
        {slots.inbox ? (
          slots.inbox(route.collection)
        ) : (
          <EmptyState illustration={<ThemeIllustration />} title="Nothing here yet" />
        )}
      </div>
    </section>
  );
}

function PageFrame({
  route,
  chatCollapsed,
  onShowChat,
  onOpenChatView,
  children,
}: {
  route: WorkspaceRoute;
  chatCollapsed: boolean;
  onShowChat: () => void;
  onOpenChatView: () => void;
  children: ReactNode;
}) {
  const slots = useShellSlots();
  const meta = collectionMeta(route.collection);
  if (route.taskId === null) {
    return (
      <main id={MAIN_ID} className="sym-page" tabIndex={-1} {...{ [PANE_ATTRIBUTE]: "page" }}>
        {children}
      </main>
    );
  }
  const taskId = route.taskId;
  const chatStatus = slots.chatStatus?.(taskId) ?? null;
  return (
    <main id={MAIN_ID} className="sym-page" tabIndex={-1} {...{ [PANE_ATTRIBUTE]: "page" }}>
      <div className="sym-page-header">
        <Link
          href={meta.href}
          className="sym-icon-button sym-mobile-only -ml-2 size-8"
          aria-label={`Back to ${meta.label}`}
        >
          <ChevronIcon direction="left" size={18} />
        </Link>
        <div className="flex min-w-0 flex-1 items-center gap-2.5">{slots.taskHeader?.(taskId)}</div>
        <button
          type="button"
          className="sym-mobile-only h-[30px] items-center gap-1.5 rounded-sym border border-sym-line-strong bg-sym-surface px-2.5 font-medium text-[13px]"
          onClick={onOpenChatView}
        >
          <ChatIcon size={14} />
          Chat
        </button>
      </div>
      <div className="sym-page-scroll">
        <div className="sym-sheet">
          {slots.page?.(taskId)}
          {children}
        </div>
      </div>
      {chatCollapsed ? (
        <button
          type="button"
          id="sym-chat-corner"
          className="sym-floating-control sym-chat-corner"
          aria-label={chatStatus ? `Show chat, ${chatStatus}` : "Show chat"}
          onClick={onShowChat}
        >
          <ChatIcon />
          Chat
          {chatStatus ? (
            <span aria-hidden="true" className="sym-chat-corner-dot" data-slot="chat-status" />
          ) : null}
        </button>
      ) : null}
    </main>
  );
}

/**
 * Whether a panel's group has registered it yet. The imperative handle is attached when the panel
 * renders, but its constraints are registered by the group in a layout effect, and every method on
 * the handle throws until then. `getSize` is the cheapest way to ask.
 */
function panelIsRegistered(panel: PanelImperativeHandle): boolean {
  try {
    panel.getSize();
    return true;
  } catch {
    return false;
  }
}

/** A panel's width in pixels, or 0 while its group has not registered it (and it has no size yet). */
function panelSizeOf(panel: PanelImperativeHandle | null): number {
  if (!panel || !panelIsRegistered(panel)) return 0;
  return panel.getSize().inPixels;
}

/**
 * Runs `apply` against a panel once its group has registered it, and returns a cleanup that cancels
 * the wait. A panel mounted by the render this effect belongs to — the chat panel, the moment a task
 * is opened — is not addressable yet, and calling it threw, which took down the whole app on the
 * first navigation into a task. The attempt is repeated on following frames while the panel is still
 * there, and given up quietly if it never registers.
 */
function whenPanelReady(
  ref: RefObject<PanelImperativeHandle | null>,
  apply: (panel: PanelImperativeHandle) => void,
): () => void {
  let frame: number | null = null;
  let attemptsLeft = 10;
  const attempt = () => {
    frame = null;
    const panel = ref.current;
    if (!panel) return;
    if (panelIsRegistered(panel)) {
      apply(panel);
      return;
    }
    attemptsLeft -= 1;
    if (attemptsLeft > 0) frame = requestAnimationFrame(attempt);
  };
  attempt();
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

function ChatFrame({
  taskId,
  onHide,
  onBackToPage,
}: {
  taskId: string;
  onHide: () => void;
  onBackToPage: () => void;
}) {
  const slots = useShellSlots();
  return (
    <aside
      className="sym-panel sym-chat"
      aria-labelledby={CHAT_TITLE_ID}
      {...{ [PANE_ATTRIBUTE]: "chat" }}
    >
      <div className="sym-panel-header gap-1.5">
        <button
          type="button"
          className="sym-icon-button sym-mobile-only -ml-2 size-8"
          aria-label="Back to page"
          onClick={onBackToPage}
        >
          <ChevronIcon direction="left" size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <h2 id={CHAT_TITLE_ID} className="sym-chat-kicker m-0" tabIndex={-1}>
            <span aria-hidden="true" className="sym-chat-badge">
              S
            </span>
            Simon
          </h2>
          {slots.chatTitle ? (
            <div className="truncate font-medium text-[13.5px]">{slots.chatTitle(taskId)}</div>
          ) : null}
        </div>
        <button
          type="button"
          className="sym-mobile-only h-[30px] items-center rounded-sym border border-sym-line-strong bg-sym-surface px-2.5 font-medium text-[13px]"
          onClick={onBackToPage}
        >
          Page
        </button>
        <HintTooltip label="Hide chat" side="bottom">
          <button
            type="button"
            className="sym-icon-button sym-desktop-only"
            aria-label="Hide chat"
            onClick={onHide}
          >
            <PanelToggleIcon side="right" />
          </button>
        </HintTooltip>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{slots.chat?.(taskId)}</div>
    </aside>
  );
}

/**
 * Desktop panel sizes for the theme on screen: the live document theme when there is one, else the
 * first-paint theme from the appearance cookie.
 */
export function workspacePanelSizes(themeId: ThemeId, doc: Document | undefined) {
  const live = doc?.documentElement.dataset.theme;
  return panelSizes(themes[isThemeId(live) ? live : themeId].geometry.panelInset);
}

export interface WorkspaceProps {
  readonly route: WorkspaceRoute;
  /** Receives the shell controller used by keyboard and palette actions. */
  readonly onController: (controller: ShellController | null) => void;
  /**
   * The theme rendered on first paint (from the appearance cookie), which sizes the framed panels.
   * A theme changed in place while the workspace is open keeps the current widths.
   */
  readonly themeId?: ThemeId;
  readonly children: ReactNode;
}

/**
 * The workspace frame from the sample: icon rail, task list, page and chat. Desktop panels resize
 * (task list 240–400 px, chat 300–480 px) and collapse to the rail's "Show task list" control and the
 * chat corner control; at laptop width the task list becomes a drawer; on phones one surface shows at
 * a time. The DOM tree is identical in every mode, so page and chat content never remount when the
 * window crosses a breakpoint.
 */
export function Workspace({
  route,
  onController,
  themeId = DEFAULT_THEME_ID,
  children,
}: WorkspaceProps) {
  const mode = useLayoutMode();
  // Fixed for the life of the workspace: changing a panel's size props re-registers it and would
  // discard the user's resized widths. The live document theme wins over the first-paint prop, so a
  // workspace opened after an in-place theme change (for example from Appearance settings) uses it;
  // during hydration both are the same cookie theme.
  const [sizes] = useState(() =>
    workspacePanelSizes(themeId, typeof document === "undefined" ? undefined : document),
  );
  const slots = useShellSlots();
  const [state, dispatch] = useReducer(shellReducer, route, initialShellState);
  const inboxPanel = usePanelRef();
  const chatPanel = usePanelRef();
  const modeRef = useRef(mode);
  const drawerTrigger = useRef<HTMLElement | null>(null);
  /** Set by `revealInbox` while the list is not visible yet (for example during navigation). */
  const pendingInboxFocus = useRef(false);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    dispatch({ type: "route", route });
  }, [route]);

  // Keep the resizable panels in step with shell state whenever the desktop layout is active.
  useEffect(() => {
    if (mode !== "desktop") return;
    return whenPanelReady(inboxPanel, (panel) => {
      if (state.inboxCollapsed && !panel.isCollapsed()) panel.collapse();
      if (!state.inboxCollapsed && panel.isCollapsed()) panel.expand();
    });
  }, [mode, state.inboxCollapsed, inboxPanel]);

  useEffect(() => {
    if (mode !== "desktop" || route.taskId === null) return;
    return whenPanelReady(chatPanel, (panel) => {
      if (state.chatCollapsed && !panel.isCollapsed()) panel.collapse();
      if (!state.chatCollapsed && panel.isCollapsed()) panel.expand();
    });
  }, [mode, state.chatCollapsed, chatPanel, route.taskId]);

  const onInboxResize = useCallback((size: PanelSize) => {
    if (modeRef.current !== "desktop") return;
    dispatch({ type: "set-inbox-collapsed", collapsed: size.inPixels < 1 });
  }, []);

  const onChatResize = useCallback((size: PanelSize) => {
    if (modeRef.current !== "desktop") return;
    dispatch({ type: "set-chat-collapsed", collapsed: size.inPixels < 1 });
  }, []);

  const showList = useCallback(() => {
    if (modeRef.current === "laptop") {
      drawerTrigger.current = document.activeElement as HTMLElement | null;
      dispatch({ type: "set-drawer", open: true });
    } else {
      dispatch({ type: "set-inbox-collapsed", collapsed: false });
    }
    focusById(INBOX_TITLE_ID);
  }, []);

  const hideList = useCallback(() => {
    if (modeRef.current === "laptop") {
      dispatch({ type: "set-drawer", open: false });
    } else {
      dispatch({ type: "set-inbox-collapsed", collapsed: true });
    }
    requestAnimationFrame(() => {
      // Return focus to whatever opened the drawer, else to the rail's "Show task list" control that
      // replaces the hidden list (as the chat corner control does for the chat), else the rail item.
      const target =
        drawerTrigger.current?.isConnected && drawerTrigger.current
          ? drawerTrigger.current
          : (document.querySelector<HTMLElement>(`#${SHOW_LIST_ID}`) ??
            document.querySelector<HTMLElement>('.sym-rail [aria-current="page"]'));
      drawerTrigger.current = null;
      target?.focus();
    });
  }, []);

  const toggleDrawer = useCallback(() => {
    if (state.drawerOpen) {
      hideList();
    } else {
      showList();
    }
  }, [state.drawerOpen, hideList, showList]);

  const showChat = useCallback(() => {
    dispatch({ type: "set-chat-collapsed", collapsed: false });
    focusById(CHAT_TITLE_ID);
  }, []);

  const hideChat = useCallback(() => {
    dispatch({ type: "set-chat-collapsed", collapsed: true });
    focusById("sym-chat-corner");
  }, []);

  const openChatView = useCallback(() => {
    dispatch({ type: "show", view: "chat" });
    focusById(CHAT_TITLE_ID);
  }, []);

  const backToPage = useCallback(() => {
    dispatch({ type: "show", view: "page" });
    focusById(MAIN_ID);
  }, []);

  // Escape closes the laptop drawer unless a menu or dialog above it handles the key first.
  useEffect(() => {
    if (mode !== "laptop" || !state.drawerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const contexts = describeFocus(event.target, document).contexts;
      if (contexts.includes("modal") || contexts.includes("menu")) return;
      event.preventDefault();
      hideList();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mode, state.drawerOpen, hideList]);

  // Clicking the page or chat while the laptop drawer is open closes it (sample 1024 behavior).
  const onPanelsPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (modeRef.current !== "laptop" || !state.drawerOpen) return;
      const target = event.target as Element;
      if (target.closest("#sym-inbox-panel") || target.closest(".sym-rail")) return;
      dispatch({ type: "set-drawer", open: false });
    },
    [state.drawerOpen],
  );

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  /*
   * Panel persistence (§10.3, `panels`). The workspace feature owns the stored preference and hands
   * it in through the `panels` slot; the shell applies it once it arrives and reports every change
   * back. Stored widths are panel widths without the theme's frame inset, so they stay meaningful
   * when the theme changes.
   */
  const inset = sizes.inbox.default - INBOX_SIZE.default;
  const panels = slots.panels;
  const panelsRef = useRef(panels);
  /** The layout last applied or reported, so the shell never echoes a layout back unchanged. */
  const knownLayout = useRef<string | null>(null);
  const storedWidths = useRef<{ inbox: number | null; chat: number | null }>({
    inbox: null,
    chat: null,
  });
  useEffect(() => {
    panelsRef.current = panels;
  }, [panels]);

  const reportLayout = useCallback(() => {
    const seam = panelsRef.current;
    if (!seam || knownLayout.current === null) return;
    const next: ShellPanelLayout = {
      inboxWidth: storedWidths.current.inbox,
      chatWidth: storedWidths.current.chat,
      inboxCollapsed: stateRef.current.inboxCollapsed,
      chatCollapsed: stateRef.current.chatCollapsed,
    };
    const key = JSON.stringify(next);
    if (key === knownLayout.current) return;
    knownLayout.current = key;
    seam.onLayoutChange(next);
  }, []);

  const onLayoutChanged = useCallback(
    (_layout: Layout, meta: LayoutChangedMeta) => {
      if (!meta.isUserInteraction || modeRef.current !== "desktop") return;
      const inboxSize = panelSizeOf(inboxPanel.current);
      const chatSize = panelSizeOf(chatPanel.current);
      if (inboxSize > 1) storedWidths.current.inbox = Math.round(inboxSize - inset);
      if (chatSize > 1) storedWidths.current.chat = Math.round(chatSize - inset);
      reportLayout();
    },
    [inboxPanel, chatPanel, inset, reportLayout],
  );

  // The account's layout, applied once it is known and whenever another device changes it.
  const storedLayout = panels?.layout ?? null;
  useEffect(() => {
    if (!storedLayout) return;
    const key = JSON.stringify(storedLayout);
    if (knownLayout.current === key) return;
    knownLayout.current = key;
    storedWidths.current = { inbox: storedLayout.inboxWidth, chat: storedLayout.chatWidth };
    dispatch({ type: "set-inbox-collapsed", collapsed: storedLayout.inboxCollapsed });
    dispatch({ type: "set-chat-collapsed", collapsed: storedLayout.chatCollapsed });
    if (modeRef.current !== "desktop") return;
    const cancels: Array<() => void> = [];
    if (storedLayout.inboxWidth !== null && !storedLayout.inboxCollapsed) {
      const width = storedLayout.inboxWidth + inset;
      cancels.push(whenPanelReady(inboxPanel, (panel) => panel.resize(width)));
    }
    if (storedLayout.chatWidth !== null && !storedLayout.chatCollapsed) {
      const width = storedLayout.chatWidth + inset;
      cancels.push(whenPanelReady(chatPanel, (panel) => panel.resize(width)));
    }
    return () => {
      for (const cancel of cancels) cancel();
    };
  }, [storedLayout, inset, inboxPanel, chatPanel]);

  // Collapsing or showing a panel is part of the stored layout too.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the collapse flags are what this reports.
  useEffect(() => {
    reportLayout();
  }, [reportLayout, state.inboxCollapsed, state.chatCollapsed]);

  // Complete a pending `revealInbox` once the list is visible (after navigation or expansion).
  useEffect(() => {
    if (!pendingInboxFocus.current || !isInboxVisible(state, mode)) return;
    pendingInboxFocus.current = false;
    focusById(INBOX_TITLE_ID);
  }, [state, mode]);

  const controller = useMemo<ShellController>(
    () => ({
      focusPane: (pane: PaneId) => {
        const current = stateRef.current;
        if (pane === "inbox") {
          if (modeRef.current === "mobile" && current.route.taskId !== null) return;
          if (!isInboxVisible(current, modeRef.current)) showList();
          else focusById(INBOX_TITLE_ID);
          return;
        }
        if (current.route.taskId === null) return;
        if (pane === "page") {
          if (modeRef.current === "mobile") dispatch({ type: "show", view: "page" });
          focusById(MAIN_ID);
          return;
        }
        if (modeRef.current === "mobile") dispatch({ type: "show", view: "chat" });
        else dispatch({ type: "set-chat-collapsed", collapsed: false });
        requestAnimationFrame(() => {
          const composer = document.querySelector<HTMLElement>(
            `[${PANE_ATTRIBUTE}="chat"] [${ACTION_CONTEXT_ATTRIBUTE}="composer"] textarea, [${PANE_ATTRIBUTE}="chat"] [${ACTION_CONTEXT_ATTRIBUTE}="composer"] [contenteditable="true"]`,
          );
          (composer ?? document.getElementById(CHAT_TITLE_ID))?.focus();
        });
      },
      revealInbox: () => {
        const current = stateRef.current;
        const layout = modeRef.current;
        if (isInboxVisible(current, layout)) {
          pendingInboxFocus.current = false;
          focusById(INBOX_TITLE_ID);
          return;
        }
        pendingInboxFocus.current = true;
        if (layout === "desktop") {
          dispatch({ type: "set-inbox-collapsed", collapsed: false });
        } else if (layout === "laptop") {
          drawerTrigger.current = document.activeElement as HTMLElement | null;
          dispatch({ type: "set-drawer", open: true });
        }
        // On a phone the list view appears when the navigation reaches the collection route.
      },
      toggleInbox: () => {
        if (isInboxVisible(stateRef.current, modeRef.current)) hideList();
        else showList();
      },
      toggleChat: () => {
        const current = stateRef.current;
        if (current.route.taskId === null) return;
        if (modeRef.current === "mobile") {
          dispatch({ type: "show", view: current.mobileView === "chat" ? "page" : "chat" });
        } else if (current.chatCollapsed) {
          showChat();
        } else {
          hideChat();
        }
      },
      isInboxVisible: () => isInboxVisible(stateRef.current, modeRef.current),
      isChatVisible: () => isChatVisible(stateRef.current, modeRef.current),
    }),
    [showList, hideList, showChat, hideChat],
  );

  useEffect(() => {
    onController(controller);
    return () => onController(null);
  }, [controller, onController]);

  const inboxVisible = isInboxVisible(state, mode);
  const mobileView = route.taskId === null ? "list" : state.mobileView;

  return (
    <div
      className="sym-workspace"
      data-layout={mode}
      data-inbox={state.inboxCollapsed ? "collapsed" : "expanded"}
      data-chat={route.taskId === null ? "absent" : state.chatCollapsed ? "collapsed" : "expanded"}
      data-drawer={state.drawerOpen ? "open" : "closed"}
      data-mobile-view={mobileView}
    >
      <IconRail
        route={route}
        mode={mode}
        inboxVisible={inboxVisible}
        onToggleDrawer={toggleDrawer}
        onShowList={showList}
      />
      <ResizablePanelGroup
        id="sym-workspace-panels"
        orientation="horizontal"
        className="sym-panels"
        disabled={mode !== "desktop"}
        onPointerDown={onPanelsPointerDown}
        onLayoutChanged={onLayoutChanged}
      >
        <ResizablePanel
          id="sym-inbox-panel"
          panelRef={inboxPanel}
          className="sym-panel-slot sym-panel-slot--framed"
          defaultSize={sizes.inbox.default}
          minSize={sizes.inbox.min}
          maxSize={sizes.inbox.max}
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          onResize={onInboxResize}
        >
          <InboxFrame route={route} onHide={hideList} />
        </ResizablePanel>
        <ResizableHandle
          id="sym-inbox-resizer"
          aria-label="Resize task list"
          disabled={mode !== "desktop"}
        />
        <ResizablePanel id="sym-page-panel" className="sym-panel-slot" minSize={PAGE_MIN_SIZE}>
          <PageFrame
            route={route}
            chatCollapsed={state.chatCollapsed && mode !== "mobile"}
            onShowChat={showChat}
            onOpenChatView={openChatView}
          >
            {children}
          </PageFrame>
        </ResizablePanel>
        {route.taskId !== null ? (
          <>
            <ResizableHandle
              id="sym-chat-resizer"
              aria-label="Resize chat"
              disabled={mode !== "desktop"}
            />
            <ResizablePanel
              id="sym-chat-panel"
              panelRef={chatPanel}
              className="sym-panel-slot sym-panel-slot--framed"
              defaultSize={state.chatCollapsed ? 0 : sizes.chat.default}
              minSize={sizes.chat.min}
              maxSize={sizes.chat.max}
              collapsible
              collapsedSize={0}
              groupResizeBehavior="preserve-pixel-size"
              onResize={onChatResize}
            >
              <ChatFrame taskId={route.taskId} onHide={hideChat} onBackToPage={backToPage} />
            </ResizablePanel>
          </>
        ) : null}
      </ResizablePanelGroup>
      {route.taskId === null ? (
        <div className="sym-quick-chat-slot" data-slot="quick-chat">
          {slots.quickChat}
        </div>
      ) : null}
    </div>
  );
}
