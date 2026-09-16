import { schedulingDefaultPreferences } from "@symplist/contracts";
import { vi } from "vitest";
import type { SchedulingApi } from "./api.ts";

export const schedulingTaskId = "019947aa-0000-7000-8000-000000000001";
export const emptySchedule = {
  taskId: schedulingTaskId,
  version: 0,
  deadline: null,
  deadlineAt: null,
  reminders: [],
};
export const defaultPreferences = {
  version: 0,
  data: schedulingDefaultPreferences,
  remindersEnabled: true,
  emailEnabled: true,
};
export function stubSchedulingApi(overrides: Partial<SchedulingApi> = {}): SchedulingApi {
  return {
    get: vi.fn(async () => emptySchedule),
    summaries: vi.fn(async () => []),
    save: vi.fn(async (_id, input) => ({
      ...input,
      taskId: schedulingTaskId,
      version: input.baseVersion + 1,
      deadlineAt: null,
      reminders: [],
    })),
    preview: vi.fn(async () => ({ deadlineAt: null, reminders: [] })),
    preferences: vi.fn(async () => defaultPreferences),
    savePreferences: vi.fn(async (version, data) => ({
      ...defaultPreferences,
      version: version + 1,
      data,
    })),
    notifications: vi.fn(async () => ({ items: [], unreadCount: 0, nextCursor: null })),
    mark: vi.fn(async () => undefined),
    snooze: vi.fn(async () => emptySchedule),
    calendar: vi.fn(async () => ({ items: [], nextCursor: null })),
    ...overrides,
  };
}
