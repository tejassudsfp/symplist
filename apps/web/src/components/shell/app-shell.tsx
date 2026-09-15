"use client";

import { usePathname, useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { ActionsProvider } from "@/actions/provider";
import { actionRegistry } from "@/actions/registry-index";
import type { ActionServices, AppAction, ShellController } from "@/actions/types";
import { useAnnouncer } from "@/components/ui/status-announcer";
import type { ThemeId } from "@/theme/registry";
import { isExcludedRoute, parseWorkspaceRoute } from "./routes.ts";
import { TopBar } from "./top-bar.tsx";
import { INBOX_TITLE_ID, MAIN_ID, Workspace } from "./workspace.tsx";

function isRendered(element: HTMLElement): boolean {
  return typeof element.checkVisibility === "function"
    ? element.checkVisibility()
    : element.getClientRects().length > 0;
}

/**
 * Moves focus to the primary content: the page, or on a phone's list view (where the page is not
 * shown) the task list heading.
 */
function skipToContent(event: MouseEvent<HTMLAnchorElement>) {
  const main = document.getElementById(MAIN_ID);
  const inbox = document.getElementById(INBOX_TITLE_ID);
  const target = main && isRendered(main) ? main : inbox && isRendered(inbox) ? inbox : null;
  if (!target) return;
  event.preventDefault();
  target.focus();
}

export interface AppShellProps {
  readonly children: ReactNode;
  /** Defaults to the app-wide registry; tests pass a smaller set. */
  readonly actions?: readonly AppAction[];
  /** The theme from the appearance cookie, used to size the framed workspace panels. */
  readonly themeId?: ThemeId;
}

/**
 * The signed-in app frame: a skip link, the top bar, and either the workspace (Now, Later,
 * Unclassified and their tasks) or a plain main region for settings, archive and administration.
 * It owns the keyboard action registry for everything inside it.
 */
export function AppShell({ children, actions = actionRegistry, themeId }: AppShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { announce } = useAnnouncer();
  const controllerRef = useRef<ShellController | null>(null);

  const route = useMemo(() => parseWorkspaceRoute(pathname), [pathname]);
  const routeRef = useRef(route);
  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  const onController = useCallback((controller: ShellController | null) => {
    controllerRef.current = controller;
  }, []);

  const services = useMemo<ActionServices>(
    () => ({
      navigate: (href) => {
        // Excluded route groups always load as a new document so no app state or SDK carries over (§15).
        if (isExcludedRoute(href)) window.location.assign(href);
        else router.push(href);
      },
      assign: (href) => window.location.assign(href),
      announce: (message) => announce(message),
      get route() {
        return routeRef.current;
      },
      get shell() {
        return controllerRef.current;
      },
    }),
    [router, announce],
  );

  return (
    <ActionsProvider actions={actions} services={services}>
      <div className="sym-app">
        <a className="sym-skip-link" href={`#${MAIN_ID}`} onClick={skipToContent}>
          Skip to content
        </a>
        <TopBar />
        <div className="sym-body">
          {route ? (
            <Workspace route={route} onController={onController} {...(themeId ? { themeId } : {})}>
              {children}
            </Workspace>
          ) : (
            <main id={MAIN_ID} className="sym-page flex-1 overflow-auto" tabIndex={-1}>
              {children}
            </main>
          )}
        </div>
      </div>
    </ActionsProvider>
  );
}
