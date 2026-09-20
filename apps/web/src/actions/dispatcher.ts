import {
  DEFAULT_KEYBOARD_PREFERENCES,
  effectiveBindings,
  isSuppressedBySingleKeyToggle,
  type KeyboardPreferences,
} from "./bindings.ts";
import { describeFocus } from "./focus.ts";
import {
  type Chord,
  chordCanonical,
  chordFromEvent,
  isUnmodified,
  type KeyEventLike,
  type ParsedBinding,
} from "./keys.ts";
import type {
  ActionAvailability,
  ActionContext,
  ActionEnvironment,
  ActionServices,
  ActionSource,
  AppAction,
  PaneId,
  Platform,
} from "./types.ts";

/** Default time to finish a sequence such as `g` then `c` (note 13: short and configurable). */
export const DEFAULT_SEQUENCE_TIMEOUT_MS = 1500;

/** A keyboard event as the dispatcher sees it. */
export interface DispatchKeyEvent extends KeyEventLike {
  readonly target: EventTarget | null;
  readonly repeat: boolean;
  readonly isComposing: boolean;
  readonly keyCode?: number;
  readonly defaultPrevented: boolean;
  preventDefault(): void;
  /** `KeyboardEvent.getModifierState`, used to recognize AltGr character input. */
  getModifierState?(key: string): boolean;
}

export type DispatchResult =
  | { readonly kind: "ignored" }
  | { readonly kind: "sequence-pending"; readonly steps: readonly string[] }
  | { readonly kind: "sequence-reset" }
  | { readonly kind: "ran"; readonly actionId: string }
  | { readonly kind: "repeat-suppressed"; readonly actionId: string }
  | { readonly kind: "disabled"; readonly actionId: string; readonly reason?: string };

export type InvokeResult =
  | { readonly kind: "ran"; readonly actionId: string }
  | { readonly kind: "disabled"; readonly actionId: string; readonly reason?: string }
  | { readonly kind: "unknown" };

export interface TimerApi {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface KeyboardDispatcherOptions {
  readonly getActions: () => readonly AppAction[];
  readonly getPreferences?: () => KeyboardPreferences;
  readonly getServices: () => ActionServices;
  readonly platform: Platform;
  readonly document: Document;
  readonly sequenceTimeoutMs?: number;
  readonly timers?: TimerApi;
  /** Called whenever the pending sequence changes (for a brief progress hint). */
  readonly onSequenceChange?: (steps: readonly string[] | null) => void;
  /** Called when a matched action is disabled, so the UI can explain why. */
  readonly onDisabled?: (action: AppAction, reason: string | undefined) => void;
  /** Called when an action throws or rejects; errors never escape the key handler. */
  readonly onError?: (action: AppAction, error: unknown) => void;
}

const contextRank: Readonly<Record<ActionContext, number>> = {
  modal: 0,
  menu: 0,
  editor: 1,
  composer: 1,
  pane: 2,
  app: 3,
};

interface Candidate {
  readonly action: AppAction;
  readonly binding: ParsedBinding;
}

const defaultTimers: TimerApi = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The single keyboard dispatcher (§10.2, note 13). It resolves the active contexts from focus, applies
 * the typing and IME guard, tracks sequences with a timeout and Escape reset, suppresses held-key
 * repeat unless an action allows it, and runs only the winning enabled action.
 */
export class KeyboardDispatcher {
  private pending: { steps: Chord[]; timer: unknown } | null = null;
  private readonly timers: TimerApi;
  private readonly timeoutMs: number;

  constructor(private readonly options: KeyboardDispatcherOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.timeoutMs = options.sequenceTimeoutMs ?? DEFAULT_SEQUENCE_TIMEOUT_MS;
  }

  /** The pending sequence steps in canonical form, or null. */
  get pendingSequence(): readonly string[] | null {
    return this.pending ? this.pending.steps.map(chordCanonical) : null;
  }

  dispose(): void {
    this.resetSequence(false);
  }

  handleKeyDown(event: DispatchKeyEvent): DispatchResult {
    if (event.defaultPrevented) return { kind: "ignored" };
    if (event.isComposing || event.keyCode === 229) {
      this.resetSequence();
      return { kind: "ignored" };
    }
    const chord = chordFromEvent(event, this.options.platform);
    if (!chord) return { kind: "ignored" };
    const focus = describeFocus(event.target, this.options.document);
    // AltGr reports Control and Alt on Windows and Linux while it types a character (for example
    // `@` on German and French layouts); in a text field that is typing, never a shortcut.
    if (focus.typing && event.getModifierState?.("AltGraph") === true) {
      this.resetSequence();
      return { kind: "ignored" };
    }
    const candidates = this.candidatesFor(focus.contexts, focus.pane);

    if (this.pending) {
      const pendingResult = this.continueSequence(event, chord, focus, candidates);
      if (pendingResult) return pendingResult;
    }

    const unmodified = isUnmodified(chord);
    if (unmodified && focus.typing && chord.key !== "escape") return { kind: "ignored" };
    if (unmodified && focus.activation && (chord.key === "enter" || chord.key === "space")) {
      return { kind: "ignored" };
    }

    const canonical = chordCanonical(chord);
    const exact = candidates.filter(
      ({ binding }) => binding.steps.length === 1 && binding.canonical === canonical,
    );
    if (exact.length > 0) return this.runBest(exact, event, focus.pane);

    if (unmodified && !focus.typing) {
      const starts = candidates.some(
        ({ binding }) =>
          binding.steps.length > 1 && chordCanonical(binding.steps[0] as Chord) === canonical,
      );
      if (starts) {
        if (event.repeat) {
          event.preventDefault();
          return { kind: "ignored" };
        }
        event.preventDefault();
        this.startSequence([chord]);
        return { kind: "sequence-pending", steps: [canonical] };
      }
    }
    return { kind: "ignored" };
  }

  /**
   * Whether an action could run now from `source`, with its reason when it cannot, without running
   * it or announcing anything. Lists such as the command palette use it to show disabled actions and
   * their reasons before anyone picks one (note 13). Null for an unknown action id.
   */
  check(
    actionId: string,
    source: ActionSource,
    pane: PaneId | null = null,
  ): ActionAvailability | null {
    const action = this.options.getActions().find((candidate) => candidate.id === actionId);
    if (!action) return null;
    return action.availability(this.environment(source, pane));
  }

  /**
   * Runs an action from a button, menu or the palette through the same availability check the
   * keyboard uses. A disabled action never runs.
   */
  async invoke(
    actionId: string,
    source: ActionSource,
    pane: PaneId | null = null,
  ): Promise<InvokeResult> {
    const action = this.options.getActions().find((candidate) => candidate.id === actionId);
    if (!action) return { kind: "unknown" };
    const environment = this.environment(source, pane);
    const availability = action.availability(environment);
    if (!availability.enabled) {
      this.options.onDisabled?.(action, availability.reason);
      return {
        kind: "disabled",
        actionId,
        ...(availability.reason ? { reason: availability.reason } : {}),
      };
    }
    try {
      await action.run(environment);
    } catch (error) {
      this.options.onError?.(action, error);
    }
    return { kind: "ran", actionId };
  }

  private environment(source: ActionSource, pane: PaneId | null): ActionEnvironment {
    return { source, platform: this.options.platform, pane, services: this.options.getServices() };
  }

  private candidatesFor(contexts: readonly ActionContext[], pane: PaneId | null): Candidate[] {
    const preferences = this.options.getPreferences?.() ?? DEFAULT_KEYBOARD_PREFERENCES;
    const actions = this.options.getActions();
    const bindings = effectiveBindings(actions, preferences);
    const candidates: Candidate[] = [];
    for (const action of actions) {
      const binding = bindings.get(action.id);
      if (!binding) continue;
      if (!contexts.includes(action.context)) continue;
      if (action.context === "pane" && action.pane !== undefined && action.pane !== pane) continue;
      if (isSuppressedBySingleKeyToggle(binding, preferences)) continue;
      candidates.push({ action, binding });
    }
    return candidates.sort((a, b) => {
      const rank = contextRank[a.action.context] - contextRank[b.action.context];
      if (rank !== 0) return rank;
      // A pane-specific action outranks a pane-agnostic one in the same context.
      return Number(a.action.pane === undefined) - Number(b.action.pane === undefined);
    });
  }

  private continueSequence(
    event: DispatchKeyEvent,
    chord: Chord,
    focus: ReturnType<typeof describeFocus>,
    candidates: readonly Candidate[],
  ): DispatchResult | null {
    const pending = this.pending;
    if (!pending) return null;
    if (chord.key === "escape" && isUnmodified(chord)) {
      event.preventDefault();
      this.resetSequence();
      return { kind: "sequence-reset" };
    }
    if (focus.typing || !isUnmodified(chord)) {
      this.resetSequence();
      return null;
    }
    if (event.repeat) {
      // A held key never advances or breaks a sequence.
      event.preventDefault();
      return { kind: "ignored" };
    }
    const steps = [...pending.steps, chord];
    const keys = steps.map(chordCanonical);
    const matchesPrefix = (binding: ParsedBinding, length: number) =>
      binding.steps.length >= length &&
      keys.every((key, index) => chordCanonical(binding.steps[index] as Chord) === key);
    const complete = candidates.filter(
      ({ binding }) =>
        binding.steps.length === steps.length && matchesPrefix(binding, steps.length),
    );
    if (complete.length > 0) {
      this.resetSequence();
      return this.runBest(complete, event, focus.pane);
    }
    const continues = candidates.some(
      ({ binding }) => binding.steps.length > steps.length && matchesPrefix(binding, steps.length),
    );
    if (continues) {
      event.preventDefault();
      this.startSequence(steps);
      return { kind: "sequence-pending", steps: keys };
    }
    // Not part of any sequence: drop the sequence and treat the key as a fresh press.
    this.resetSequence();
    return null;
  }

  private runBest(
    candidates: readonly Candidate[],
    event: DispatchKeyEvent,
    pane: PaneId | null,
  ): DispatchResult {
    const environment = this.environment("keyboard", pane);
    let firstDisabled: { action: AppAction; reason: string | undefined } | null = null;
    for (const { action } of candidates) {
      const availability = action.availability(environment);
      if (!availability.enabled) {
        firstDisabled ??= { action, reason: availability.reason };
        continue;
      }
      event.preventDefault();
      if (event.repeat && !action.allowRepeat)
        return { kind: "repeat-suppressed", actionId: action.id };
      try {
        const result = action.run(environment);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.options.onError?.(action, error));
        }
      } catch (error) {
        this.options.onError?.(action, error);
      }
      return { kind: "ran", actionId: action.id };
    }
    if (firstDisabled) {
      if (!event.repeat) this.options.onDisabled?.(firstDisabled.action, firstDisabled.reason);
      return {
        kind: "disabled",
        actionId: firstDisabled.action.id,
        ...(firstDisabled.reason ? { reason: firstDisabled.reason } : {}),
      };
    }
    return { kind: "ignored" };
  }

  private startSequence(steps: Chord[]): void {
    if (this.pending) this.timers.clear(this.pending.timer);
    const timer = this.timers.set(() => this.resetSequence(), this.timeoutMs);
    this.pending = { steps, timer };
    this.options.onSequenceChange?.(steps.map(chordCanonical));
  }

  private resetSequence(notify = true): void {
    if (!this.pending) return;
    this.timers.clear(this.pending.timer);
    this.pending = null;
    if (notify) this.options.onSequenceChange?.(null);
  }
}
