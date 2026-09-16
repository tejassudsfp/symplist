import {
  type PreferenceDataByGroup,
  type PreferenceGroup,
  preferenceDataSchemas,
  preferenceDefaults,
  preferenceGroups,
  preferencesConflictDetailsSchema,
} from "@symplist/contracts";
import { ApiError } from "@/lib/api";
import type { WorkspaceApi } from "./api.ts";
import { classifyFailure, type Failure } from "./errors.ts";
import { reportSavedAppearance } from "./telemetry.ts";

/**
 * How a group's local state relates to the account (§10.3). `previewing` is the honest state after a
 * failed save: the change is applied in this browser but not stored (settings_appearance.md).
 */
export type PreferenceSaveState = "saved" | "saving" | "previewing";

export type PreferencesStatus = "idle" | "loading" | "ready" | "error";

export interface PreferenceSnapshot<Group extends PreferenceGroup> {
  /** What this browser uses now: the saved data, or an unsaved preview after a failed save. */
  readonly data: PreferenceDataByGroup[Group];
  /** What the account holds. */
  readonly saved: PreferenceDataByGroup[Group];
  readonly version: number;
  readonly state: PreferenceSaveState;
  readonly failure: Failure | null;
}

export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const browserTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Canonical JSON so two preference values compare by content, not by identity. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function samePreferenceData(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Parses stored data; an older or invalid shape reads as the group's defaults (decision WS11). */
function parseGroup<Group extends PreferenceGroup>(
  group: Group,
  data: unknown,
): PreferenceDataByGroup[Group] {
  const parsed = preferenceDataSchemas[group].safeParse(data);
  return (parsed.success ? parsed.data : preferenceDefaults[group]) as PreferenceDataByGroup[Group];
}

interface Entry {
  version: number;
  saved: unknown;
  data: unknown;
  state: PreferenceSaveState;
  failure: Failure | null;
  timer: unknown;
  inFlight: boolean;
  /** A change made while a save was in flight; saved as soon as it returns. */
  again: boolean;
  /** The newest `clientSeq` whose response was applied, so late responses are dropped. */
  applied: number;
  conflicts: number;
  snapshot: PreferenceSnapshot<PreferenceGroup> | null;
}

/** How long a rapid run of changes (dragging a panel, typing a hex value) waits before saving. */
export const SAVE_DEBOUNCE_MS = 400;
/** How many times a save is replanned against a newer version before it gives up. */
const MAX_CONFLICT_RETRIES = 3;

/**
 * The owner's preference groups (§10.3, decision WS11). Changes apply locally at once and save
 * automatically; each save carries the version it was based on and a `clientSeq`, so a slow response
 * never overwrites a newer choice, and a conflict replans against the current version instead of
 * discarding what the person just chose.
 */
export class PreferencesStore {
  private readonly entries = new Map<PreferenceGroup, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly timers: Timers;
  private readonly debounceMs: number;
  private statusValue: PreferencesStatus = "idle";
  private failureValue: Failure | null = null;
  private clientSeq = 0;
  private loading: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly api: WorkspaceApi,
    options: { readonly timers?: Timers; readonly debounceMs?: number } = {},
  ) {
    this.timers = options.timers ?? browserTimers;
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
    for (const group of preferenceGroups) {
      this.entries.set(group, {
        version: 0,
        saved: preferenceDefaults[group],
        data: preferenceDefaults[group],
        state: "saved",
        failure: null,
        timer: null,
        inFlight: false,
        again: false,
        applied: 0,
        conflicts: 0,
        snapshot: null,
      });
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) this.timers.clear(entry.timer);
      entry.timer = null;
    }
    this.listeners.clear();
  }

  get status(): PreferencesStatus {
    return this.statusValue;
  }

  get failure(): Failure | null {
    return this.failureValue;
  }

  /** Loads every group once. Repeated calls while loading share the same request. */
  ensureLoaded(): void {
    if (this.statusValue === "idle" || this.statusValue === "error") void this.load();
  }

  async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.statusValue = this.statusValue === "ready" ? "ready" : "loading";
    this.failureValue = null;
    this.emit();
    const request = (async () => {
      try {
        const response = await this.api.getPreferences();
        if (this.disposed) return;
        for (const group of preferenceGroups) {
          const entry = this.entry(group);
          const server = response.groups[group];
          const data = parseGroup(group, server.data);
          entry.version = server.version;
          entry.saved = data;
          // A preview the person is still looking at survives a load; everything else follows.
          if (entry.state === "saved" && !entry.inFlight) entry.data = data;
          entry.snapshot = null;
        }
        this.statusValue = "ready";
        this.failureValue = null;
      } catch (error) {
        if (this.disposed) return;
        this.failureValue = classifyFailure(error);
        if (this.statusValue !== "ready") this.statusValue = "error";
      } finally {
        this.loading = null;
      }
      this.emit();
    })();
    this.loading = request;
    return request;
  }

  snapshot<Group extends PreferenceGroup>(group: Group): PreferenceSnapshot<Group> {
    const entry = this.entry(group);
    if (!entry.snapshot) {
      entry.snapshot = {
        data: entry.data as PreferenceDataByGroup[PreferenceGroup],
        saved: entry.saved as PreferenceDataByGroup[PreferenceGroup],
        version: entry.version,
        state: entry.state,
        failure: entry.failure,
      };
    }
    return entry.snapshot as PreferenceSnapshot<Group>;
  }

  /** The value this browser uses now. */
  get<Group extends PreferenceGroup>(group: Group): PreferenceDataByGroup[Group] {
    return this.snapshot(group).data;
  }

  /**
   * Applies a change locally and saves it. `immediate` skips the debounce (a single deliberate
   * choice such as picking a theme); rapid changes coalesce into one save.
   */
  set<Group extends PreferenceGroup>(
    group: Group,
    data: PreferenceDataByGroup[Group],
    options: { readonly immediate?: boolean } = {},
  ): void {
    const entry = this.entry(group);
    if (samePreferenceData(entry.data, data)) return;
    entry.data = data;
    entry.snapshot = null;
    entry.conflicts = 0;
    if (samePreferenceData(entry.data, entry.saved)) {
      // Back to what the account holds: nothing to save.
      if (entry.timer !== null) this.timers.clear(entry.timer);
      entry.timer = null;
      if (!entry.inFlight) {
        entry.state = "saved";
        entry.failure = null;
      }
      this.emit();
      return;
    }
    entry.state = "saving";
    entry.failure = null;
    this.schedule(group, options.immediate === true);
    this.emit();
  }

  /** Updates a group from its current value. */
  update<Group extends PreferenceGroup>(
    group: Group,
    change: (current: PreferenceDataByGroup[Group]) => PreferenceDataByGroup[Group],
    options: { readonly immediate?: boolean } = {},
  ): void {
    this.set(group, change(this.get(group)), options);
  }

  /** Tries a failed save again with the same local value. */
  retry(group: PreferenceGroup): void {
    const entry = this.entry(group);
    if (samePreferenceData(entry.data, entry.saved)) return;
    entry.conflicts = 0;
    entry.state = "saving";
    entry.failure = null;
    this.schedule(group, true);
    this.emit();
  }

  /** A `preferences.changed` event (§7): reload the group unless this client is mid-save. */
  noteChanged(group: PreferenceGroup, version: number): void {
    const entry = this.entry(group);
    if (entry.inFlight || entry.timer !== null || version <= entry.version) return;
    void this.reload(group);
  }

  private async reload(group: PreferenceGroup): Promise<void> {
    try {
      const server = await this.api.getPreference(group);
      if (this.disposed || server.group !== group) return;
      const entry = this.entry(group);
      if (entry.inFlight || entry.timer !== null || server.version <= entry.version) return;
      const data = parseGroup(group, server.data);
      const followed = samePreferenceData(entry.data, entry.saved);
      entry.version = server.version;
      entry.saved = data;
      if (followed) entry.data = data;
      entry.snapshot = null;
      this.emit();
    } catch {
      // A failed refresh leaves the local value in place; the next save reconciles it.
    }
  }

  private entry(group: PreferenceGroup): Entry {
    return this.entries.get(group) as Entry;
  }

  private schedule(group: PreferenceGroup, immediate: boolean): void {
    const entry = this.entry(group);
    if (entry.inFlight) {
      entry.again = true;
      return;
    }
    if (entry.timer !== null) this.timers.clear(entry.timer);
    if (immediate) {
      entry.timer = null;
      void this.save(group);
      return;
    }
    entry.timer = this.timers.set(() => {
      entry.timer = null;
      void this.save(group);
    }, this.debounceMs);
  }

  private async save(group: PreferenceGroup): Promise<void> {
    const entry = this.entry(group);
    if (entry.inFlight || this.disposed) return;
    if (samePreferenceData(entry.data, entry.saved)) {
      entry.state = "saved";
      this.emit();
      return;
    }
    entry.inFlight = true;
    entry.state = "saving";
    entry.snapshot = null;
    this.emit();
    this.clientSeq += 1;
    const clientSeq = this.clientSeq;
    const data = entry.data;
    try {
      const response = await this.api.putPreference(group, {
        baseVersion: entry.version,
        clientSeq,
        data,
      });
      if (this.disposed) return;
      // Drop a response older than one already applied (§10.3 request ordering).
      if (response.clientSeq >= entry.applied) {
        if (group === "appearance")
          reportSavedAppearance(
            parseGroup("appearance", entry.saved),
            parseGroup("appearance", response.data),
          );
        entry.applied = response.clientSeq;
        entry.version = response.version;
        entry.saved = parseGroup(group, response.data);
        if (samePreferenceData(entry.data, data)) entry.data = entry.saved;
      }
      entry.conflicts = 0;
      entry.failure = null;
      entry.state = samePreferenceData(entry.data, entry.saved) ? "saved" : "saving";
    } catch (error) {
      if (this.disposed) return;
      const conflict =
        error instanceof ApiError && error.code === "preferences.conflict"
          ? preferencesConflictDetailsSchema.safeParse(error.details)
          : null;
      if (conflict?.success && entry.conflicts < MAX_CONFLICT_RETRIES) {
        // Another device saved first: take its version as the new base and keep the local choice.
        entry.conflicts += 1;
        entry.version = conflict.data.version;
        entry.saved = parseGroup(group, conflict.data.data);
        entry.failure = null;
        entry.state = samePreferenceData(entry.data, entry.saved) ? "saved" : "saving";
        entry.again = !samePreferenceData(entry.data, entry.saved);
      } else {
        entry.failure = classifyFailure(error);
        entry.state = "previewing";
      }
    } finally {
      entry.inFlight = false;
      entry.snapshot = null;
    }
    const again = entry.again;
    entry.again = false;
    this.emit();
    if (again && entry.state !== "previewing") this.schedule(group, true);
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of [...this.listeners]) listener();
  }
}
