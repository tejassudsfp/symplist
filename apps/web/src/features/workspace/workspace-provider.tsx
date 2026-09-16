"use client";

import type { PreferenceGroup, TaskCollection } from "@symplist/contracts";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { parseWorkspaceRoute } from "@/components/shell/routes";
import { useAnnouncer } from "@/components/ui/status-announcer";
import { useToast } from "@/components/ui/toast";
import { IdempotencyKeys } from "@/lib/api";
import { normalizeAppearance } from "@/theme/appearance";
import { applyAppearance } from "@/theme/appearance-client";
import { createWorkspaceApi, type WorkspaceApi } from "./api.ts";
import { TaskCommands } from "./commands.ts";
import { setWorkspaceCommands, type WorkspaceCommandBridge } from "./controller.ts";
import {
  type PreferenceSnapshot,
  type PreferencesStatus,
  PreferencesStore,
} from "./preferences-store.ts";
import {
  useWorkspaceRealtime,
  type WorkspaceRealtimeSource,
  workspaceRealtimeSource,
} from "./realtime.ts";
import { type TaskRunStatus, useTaskRunStateSource } from "./run-state.ts";
import { type CollectionSnapshot, type DetailSnapshot, TaskStore } from "./task-store.ts";
import { ancestorsOf } from "./tree.ts";
import { type WorkspaceUiState, WorkspaceUiStore } from "./ui-store.ts";
import "./workspace.css";

export interface WorkspaceContextValue {
  readonly api: WorkspaceApi;
  readonly tasks: TaskStore;
  readonly preferences: PreferencesStore;
  readonly ui: WorkspaceUiStore;
  readonly commands: TaskCommands;
  /** The collection and task in the address bar, or null outside the workspace routes. */
  readonly collection: TaskCollection | null;
  readonly openTaskId: string | null;
  /** Opens a task so its page and chat switch together. */
  readonly openTask: (collection: TaskCollection, taskId: string) => void;
  /** Client-side navigation inside the app shell. */
  readonly navigate: (href: string, options?: { readonly replace?: boolean }) => void;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export interface WorkspaceProviderProps {
  readonly children: ReactNode;
  /** The signed-in account; a change builds fresh stores so no data crosses accounts (§10.3). */
  readonly userId?: string | null;
  /** Defaults to the browser client; tests pass an in-memory fake. */
  readonly api?: WorkspaceApi;
  /** Defaults to the shared socket; `null` runs without realtime (tests, no configured origin). */
  readonly realtime?: WorkspaceRealtimeSource | null;
}

/**
 * The workspace's stores and commands for everything inside the app shell: the task trees, the
 * account's preference groups, the list view state and the writes with their confirmations. It is
 * mounted once by `FeatureSlots`, so the shell slots, the route pages (archive, settings) and the
 * keyboard actions all work on the same state.
 */
export function WorkspaceProvider({ children, userId, api, realtime }: WorkspaceProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const { announce } = useAnnouncer();
  const runStateSource = useTaskRunStateSource();
  const route = useMemo(() => parseWorkspaceRoute(pathname), [pathname]);

  const client = useMemo(() => api ?? createWorkspaceApi(), [api]);
  // A different account gets fresh stores; the shell keeps its panes mounted either way.
  const stores = useMemo(() => {
    void userId;
    return {
      tasks: new TaskStore(client),
      preferences: new PreferencesStore(client),
      ui: new WorkspaceUiStore(),
      keys: new IdempotencyKeys(),
    };
  }, [client, userId]);

  useEffect(() => {
    const { tasks, preferences } = stores;
    return () => {
      tasks.dispose();
      preferences.dispose();
    };
  }, [stores]);

  const routeRef = useRef(route);
  routeRef.current = route;
  const runStateRef = useRef(runStateSource);
  runStateRef.current = runStateSource;

  const navigate = useCallback(
    (href: string, options?: { readonly replace?: boolean }) => {
      if (options?.replace) router.replace(href);
      else router.push(href);
    },
    [router],
  );

  const commands = useMemo(
    () =>
      new TaskCommands({
        tasks: stores.tasks,
        ui: stores.ui,
        toast,
        announce,
        navigate,
        openTaskId: () => routeRef.current?.taskId ?? null,
        runStatus: (taskId: string): TaskRunStatus => runStateRef.current.get(taskId).status,
        keys: stores.keys,
      }),
    [stores, toast, announce, navigate],
  );

  const openTask = useCallback(
    (collection: TaskCollection, taskId: string) => {
      navigate(`/${collection}/${taskId}`);
    },
    [navigate],
  );

  // Preferences load once per account and follow the account from then on.
  useEffect(() => {
    stores.preferences.ensureLoaded();
  }, [stores]);

  // The account's appearance drives the document, including previews that have not saved yet (§10.3).
  const appearance = usePreferenceGroup(stores.preferences, "appearance");
  const preferencesStatus = usePreferencesStatus(stores.preferences);
  useEffect(() => {
    if (preferencesStatus !== "ready") return;
    applyAppearance(normalizeAppearance(appearance.data));
  }, [preferencesStatus, appearance.data]);

  // Recent tasks (note 14): the open task moves to the front of the account's list.
  useEffect(() => {
    const taskId = route?.taskId;
    if (!taskId || preferencesStatus !== "ready") return;
    const handle = setTimeout(() => {
      stores.preferences.update("recent", (current) => {
        if (current.taskIds[0] === taskId) return current;
        const taskIds = [taskId, ...current.taskIds.filter((id) => id !== taskId)].slice(0, 20);
        return { taskIds } as typeof current;
      });
    }, 1_500);
    return () => clearTimeout(handle);
  }, [route?.taskId, preferencesStatus, stores]);

  // Open the ancestors of a nested task so the list shows where it sits.
  useEffect(() => {
    const taskId = route?.taskId;
    const collection = route?.collection;
    if (!taskId || !collection) return;
    const list = stores.tasks.collection(collection).tasks;
    const ancestors = ancestorsOf(list, taskId);
    if (ancestors.length > 0) stores.ui.expandAll(ancestors.map((task) => task.id));
  }, [route?.taskId, route?.collection, stores]);

  const source = useMemo(
    () => (realtime === undefined ? workspaceRealtimeSource() : realtime),
    [realtime],
  );
  useWorkspaceRealtime(
    {
      onTasksChanged: (version, taskIds) => stores.tasks.noteTreeVersion(version, taskIds),
      onPreferencesChanged: (group, version) =>
        stores.preferences.noteChanged(group as PreferenceGroup, version),
      onSnapshot: (version) => stores.tasks.noteTreeVersion(version),
    },
    source,
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      api: client,
      tasks: stores.tasks,
      preferences: stores.preferences,
      ui: stores.ui,
      commands,
      collection: route?.collection ?? null,
      openTaskId: route?.taskId ?? null,
      openTask,
      navigate,
    }),
    [client, stores, commands, route?.collection, route?.taskId, openTask, navigate],
  );

  // Keyboard actions run outside the list, so they reach the same commands through this bridge.
  useEffect(() => {
    const bridge: WorkspaceCommandBridge = {
      tasks: stores.tasks,
      ui: stores.ui,
      commands,
      collection: () => routeRef.current?.collection ?? null,
      openTaskId: () => routeRef.current?.taskId ?? null,
      openTask,
    };
    setWorkspaceCommands(bridge);
    return () => setWorkspaceCommands(null, bridge);
  }, [stores, commands, openTask]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}

/** The workspace context when it is mounted (route pages rendered outside it in tests). */
export function useOptionalWorkspace(): WorkspaceContextValue | null {
  return useContext(WorkspaceContext);
}

/* ------------------------------------------------------------------------------------------------
 * Store hooks
 * --------------------------------------------------------------------------------------------- */

/** One collection's tree with every pending local change applied. */
export function useTaskCollection(collection: TaskCollection): CollectionSnapshot {
  const { tasks } = useWorkspace();
  const snapshot = useSyncExternalStore(
    tasks.subscribe,
    () => tasks.collection(collection),
    () => tasks.collection(collection),
  );
  useEffect(() => {
    tasks.ensureCollection(collection);
  }, [tasks, collection]);
  return snapshot;
}

/** One task's detail (title, place, ancestors), loaded on first use. */
export function useTaskDetail(taskId: string | null): DetailSnapshot {
  const { tasks } = useWorkspace();
  const snapshot = useSyncExternalStore(
    tasks.subscribe,
    () => (taskId ? tasks.detail(taskId) : idleDetail),
    () => idleDetail,
  );
  useEffect(() => {
    if (taskId) tasks.ensureDetail(taskId);
  }, [tasks, taskId]);
  return snapshot;
}

const idleDetail: DetailSnapshot = Object.freeze({
  status: "idle",
  detail: null,
  failure: null,
});

/** The workspace's view state (drafts, open sublists, the focused row, menus, dialogs). */
export function useWorkspaceUi<Selected>(select: (state: WorkspaceUiState) => Selected): Selected {
  const { ui } = useWorkspace();
  return useSyncExternalStore(
    ui.subscribe,
    () => select(ui.getState()),
    () => select(ui.getState()),
  );
}

/** One preference group: what this browser uses, what the account holds, and the save state. */
export function usePreferenceGroup<Group extends PreferenceGroup>(
  store: PreferencesStore,
  group: Group,
): PreferenceSnapshot<Group> {
  return useSyncExternalStore(
    store.subscribe,
    () => store.snapshot(group),
    () => store.snapshot(group),
  );
}

export function usePreferencesStatus(store: PreferencesStore): PreferencesStatus {
  return useSyncExternalStore(
    store.subscribe,
    () => store.status,
    () => store.status,
  );
}
