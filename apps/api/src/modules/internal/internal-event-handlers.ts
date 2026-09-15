import type { InternalEventHandler } from "@symplist/core/events";

/**
 * Handlers for worker announcements on `/internal/v1/events` (§6.2), one per event type. Features
 * register them from `onModuleInit`; each handler re-reads and authorizes from D1 before publishing.
 */
export class InternalEventHandlerRegistry {
  private readonly handlers = new Map<string, InternalEventHandler>();

  register(handler: InternalEventHandler): void {
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(handler.type)) {
      throw new Error(`Invalid internal event type "${handler.type}"`);
    }
    if (this.handlers.has(handler.type)) {
      throw new Error(`An internal event handler for ${handler.type} is already registered`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: string): InternalEventHandler | undefined {
    return this.handlers.get(type);
  }
}
