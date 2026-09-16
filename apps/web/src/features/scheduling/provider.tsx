"use client";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { workspaceRealtimeSource } from "@/features/workspace/realtime";
import { taskMenuExtensions } from "@/features/workspace/task-menu-extensions";
import { createSchedulingApi, type SchedulingApi } from "./api.ts";
import { ScheduleEditor } from "./schedule-editor.tsx";
import { DeadlineStore, scheduleOverlay } from "./store.ts";

const Context = createContext<{ api: SchedulingApi; deadlines: DeadlineStore } | null>(null);
export function useScheduling() {
  return useContext(Context);
}
export function SchedulingProvider({
  children,
  userId,
  api: provided,
}: {
  children: ReactNode;
  userId: string | null;
  api?: SchedulingApi;
}) {
  const api = useMemo(() => provided ?? createSchedulingApi(), [provided]);
  const deadlines = useMemo(() => {
    void userId;
    return new DeadlineStore(api);
  }, [api, userId]);
  const overlay = useSyncExternalStore(scheduleOverlay.subscribe, scheduleOverlay.get, () => null);
  useEffect(() => {
    scheduleOverlay.close();
    if (!userId) return;
    const menu = [
      {
        id: "scheduling.set_deadline",
        actionId: "scheduling.set_deadline",
        label: "Deadline…",
        onSelect: (id: string) => scheduleOverlay.open(id),
      },
      {
        id: "scheduling.add_reminder",
        actionId: "scheduling.add_reminder",
        label: "Add reminder…",
        onSelect: (id: string) => scheduleOverlay.open(id, true),
      },
    ];
    taskMenuExtensions.push(...menu);
    const source = workspaceRealtimeSource();
    const unsubscribe = source?.subscribeUser({
      onSnapshot: () => deadlines.refresh(),
      onEvent: (event) => {
        if (
          event.type === "schedule.changed" &&
          typeof event.data === "object" &&
          event.data !== null &&
          "taskId" in event.data &&
          typeof event.data.taskId === "string"
        )
          deadlines.refresh([event.data.taskId]);
      },
    });
    return () => {
      unsubscribe?.();
      deadlines.dispose();
      scheduleOverlay.close();
      for (const entry of menu) {
        const index = taskMenuExtensions.indexOf(entry);
        if (index >= 0) taskMenuExtensions.splice(index, 1);
      }
    };
  }, [deadlines, userId]);
  return (
    <Context.Provider value={useMemo(() => ({ api, deadlines }), [api, deadlines])}>
      {children}
      {userId && overlay ? (
        <ScheduleEditor
          key={overlay.taskId}
          taskId={overlay.taskId}
          addReminder={overlay.addReminder}
          api={api}
          onClose={scheduleOverlay.close}
          onSaved={(snapshot) => deadlines.set(snapshot)}
        />
      ) : null}
    </Context.Provider>
  );
}
