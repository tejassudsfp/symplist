import type {
  ComposioExecutionClient,
  ComposioSession,
  ExternalToolSchema,
  SessionConfiguration,
} from "@symplist/integrations";
import { IntegrationError } from "@symplist/integrations";

/**
 * The one external action exposed by the local browser contract. This module is installed only
 * when both `NODE_ENV=test` and `AI_PROVIDER_MODE=scripted`; production and ordinary development
 * continue to require a real Composio credential.
 */
export const SCRIPTED_CONNECTION_ACTION: ExternalToolSchema = Object.freeze({
  slug: "GMAIL_SEND_EMAIL",
  toolkit: "gmail",
  description: "Send one email through the explicitly selected Gmail connection.",
  schema: {
    type: "object",
    properties: {
      recipient: { type: "string", minLength: 3, maxLength: 320 },
      subject: { type: "string", minLength: 1, maxLength: 998 },
      body: { type: "string", minLength: 1, maxLength: 32_000 },
    },
    required: ["recipient", "subject", "body"],
    additionalProperties: false,
  },
  tags: { readOnlyHint: false, destructiveHint: true },
});

interface ScriptedSessionState {
  readonly id: string;
  readonly userId: string;
  connectedAccounts: Record<string, string[]>;
}

export interface ScriptedConnectionAttempt {
  readonly slug: string;
  readonly account: string;
  readonly maxRetries: number;
  readonly outcome: "succeeded" | "uncertain";
}

/**
 * A network-free structural Composio client for the production API's explicit test mode. It keeps
 * provider contents out of its results, records only ids/enums/counts, and deliberately turns the
 * reserved uncertain recipient into a post-send transport loss. The raw write path accepts only
 * `maxRetries: 0`, pinning the no-blind-retry boundary in the same seam the browser exercises.
 */
export class ScriptedConnectionClient implements ComposioExecutionClient {
  readonly attempts: ScriptedConnectionAttempt[] = [];
  private readonly sessionStates = new Map<string, ScriptedSessionState>();
  private sequence = 0;

  readonly sessions = {
    create: async (userId: string, config: SessionConfiguration): Promise<ComposioSession> => {
      const id = `trs_scripted_${++this.sequence}`;
      const state: ScriptedSessionState = {
        id,
        userId,
        connectedAccounts: structuredClone(config.connectedAccounts),
      };
      this.sessionStates.set(id, state);
      return this.session(state);
    },
    use: async (id: string): Promise<ComposioSession> => {
      const state = this.sessionStates.get(id);
      if (!state) {
        throw Object.assign(new Error("integration.unavailable"), { status: 404 });
      }
      return this.session(state);
    },
  };

  getClient(): ReturnType<ComposioExecutionClient["getClient"]> {
    return {
      withOptions: ({ maxRetries }) => ({
        toolRouter: {
          session: {
            execute: async (sessionId, input) => {
              if (maxRetries !== 0) throw new IntegrationError("integration.uncertain");
              const state = this.requireSession(sessionId);
              if (!this.pins(state, input.account)) {
                throw new IntegrationError("integration.unauthorized");
              }
              const outcome =
                input.arguments.recipient === "uncertain@example.test"
                  ? ("uncertain" as const)
                  : ("succeeded" as const);
              this.attempts.push({
                slug: input.tool_slug,
                account: input.account,
                maxRetries,
                outcome,
              });
              if (outcome === "uncertain") throw new Error("scripted transport lost after send");
              return {
                data: { accepted: true },
                error: null,
                log_id: `log_scripted_${this.attempts.length}`,
              };
            },
          },
        },
      }),
    };
  }

  private requireSession(id: string): ScriptedSessionState {
    const state = this.sessionStates.get(id);
    if (!state) throw Object.assign(new Error("integration.unavailable"), { status: 404 });
    return state;
  }

  private pins(state: ScriptedSessionState, account: string): boolean {
    return Object.values(state.connectedAccounts).some((accounts) => accounts.includes(account));
  }

  private session(state: ScriptedSessionState): ComposioSession {
    return {
      sessionId: state.id,
      update: async ({ connectedAccounts }) => {
        state.connectedAccounts = structuredClone(connectedAccounts);
      },
      execute: async (slug, args, options) => {
        if (slug === "COMPOSIO_SEARCH_TOOLS") {
          return {
            data: { results: [{ primary_tool_slugs: [SCRIPTED_CONNECTION_ACTION.slug] }] },
            error: null,
            logId: "log_scripted_search",
          };
        }
        if (slug === "COMPOSIO_GET_TOOL_SCHEMAS") {
          return {
            data: {
              tool_schemas: {
                [SCRIPTED_CONNECTION_ACTION.slug]: SCRIPTED_CONNECTION_ACTION.schema,
              },
            },
            error: null,
            logId: "log_scripted_schema",
          };
        }
        if (slug !== SCRIPTED_CONNECTION_ACTION.slug || !options?.account) {
          throw new IntegrationError("integration.tool_unavailable");
        }
        this.requireSession(state.id);
        if (!this.pins(state, options.account)) {
          throw new IntegrationError("integration.unauthorized");
        }
        return {
          data: { accepted: true, argumentCount: Object.keys(args).length },
          error: null,
          logId: "log_scripted_read",
        };
      },
      delete: async () => {
        this.sessionStates.delete(state.id);
      },
    };
  }
}

export function scriptedConnectionSchema(slug: string): Promise<ExternalToolSchema> {
  if (slug !== SCRIPTED_CONNECTION_ACTION.slug) {
    throw new IntegrationError("integration.tool_unavailable");
  }
  return Promise.resolve(SCRIPTED_CONNECTION_ACTION);
}
