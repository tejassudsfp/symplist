import type {
  ExecutionKindDefinition,
  ExecutionTracker,
  LocalExecutionHandler,
} from "@symplist/core/events";
import type { DbClient } from "@symplist/db";

/**
 * The dispatch intent kinds this process knows (§8.1): static definitions from the core events
 * contributors, their trackers, and the in-process handlers features register for `DURABLE=false`.
 */
export class ExecutionRegistry {
  private readonly trackers = new Map<string, ExecutionTracker>();
  private readonly handlers = new Map<string, LocalExecutionHandler>();

  constructor(
    private readonly definitions: ReadonlyMap<string, ExecutionKindDefinition>,
    private readonly db: DbClient,
    private readonly betaAccessRequired = true,
  ) {}

  kinds(): readonly string[] {
    return [...this.definitions.keys()];
  }

  definition(kind: string): ExecutionKindDefinition | undefined {
    return this.definitions.get(kind);
  }

  /** The kind's tracker, built once with the api's D1 client. */
  tracker(kind: string): ExecutionTracker | undefined {
    const existing = this.trackers.get(kind);
    if (existing) return existing;
    const definition = this.definitions.get(kind);
    const tracker = definition?.tracker?.({
      db: this.db,
      betaAccessRequired: this.betaAccessRequired,
    });
    if (tracker) this.trackers.set(kind, tracker);
    return tracker;
  }

  /** Kinds with a tracker, for reconciliation and the executor switch. */
  trackedKinds(): readonly { readonly kind: string; readonly tracker: ExecutionTracker }[] {
    return this.kinds().flatMap((kind) => {
      const tracker = this.tracker(kind);
      return tracker ? [{ kind, tracker }] : [];
    });
  }

  /**
   * Registers the in-process handler of a kind. Features call this from `onModuleInit`; the local
   * executor runs it only while `DURABLE=false`.
   */
  registerLocalHandler(kind: string, handler: LocalExecutionHandler): void {
    if (!this.definitions.has(kind)) {
      throw new Error(
        `Dispatch intent kind "${kind}" has no definition in the core events contributors`,
      );
    }
    if (this.handlers.has(kind))
      throw new Error(`A local handler for "${kind}" is already registered`);
    this.handlers.set(kind, handler);
  }

  localHandler(kind: string): LocalExecutionHandler | undefined {
    return this.handlers.get(kind);
  }
}
