import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface ComposioContractAction {
  readonly tool: {
    readonly slug: string;
    readonly toolkit: string;
    readonly schema: Record<string, unknown>;
  };
  readonly connection: {
    readonly id: string;
    readonly ownerId: string;
    readonly toolkit: string;
    readonly connectedAccountId: string;
    readonly generation: number;
  };
  readonly arguments: Record<string, unknown>;
}

export interface ComposioContractExecution {
  readonly client: "session" | "raw";
  readonly maxRetries: number;
  readonly attempts: number;
  readonly slug: string;
  readonly account?: string;
  readonly arguments: Record<string, unknown>;
}

export interface ComposioContractSubject {
  readonly searchTools: (query: string) => Promise<Record<string, unknown>>;
  readonly getToolSchemas: (slugs: readonly string[]) => Promise<readonly unknown[]>;
  readonly resolveAction: (input: {
    readonly slug: string;
    readonly arguments: unknown;
    readonly connection?: string;
  }) => Promise<ComposioContractAction>;
  readonly executeResolved: (
    action: ComposioContractAction,
    options: { readonly sideEffect: boolean },
  ) => Promise<Record<string, unknown>>;
  readonly manageConnections: (toolkit?: string) => Promise<Record<string, unknown>>;
  readonly executions: () => readonly ComposioContractExecution[];
  /** Optional provider-failure probe; it must reject with the wrapper's stable error shape. */
  readonly failureProbe?: () => Promise<unknown>;
  readonly expectedFailureCode?: string;
  readonly logLines?: () => readonly string[];
  readonly marker?: string;
}

export interface ComposioContractTarget {
  readonly name: string;
  readonly skipReason?: string;
  /** Network-backed targets may opt into a longer deadline without weakening fake targets. */
  readonly testTimeoutMs?: number;
  /** Full wrapper subject for fakes; live targets may provide only a bounded probe. */
  readonly create?: () => Promise<ComposioContractSubject> | ComposioContractSubject;
  /** Content-free live catalogue/metadata probe; never executes an external connector action. */
  readonly liveProbe?: () => Promise<void>;
}

export interface LiveComposioSettings {
  readonly apiKey: string;
}

export function liveComposioSettings(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { readonly settings: LiveComposioSettings } | { readonly skipReason: string } {
  if (env.LIVE_COMPOSIO !== "1")
    return { skipReason: "set LIVE_COMPOSIO=1 to run the bounded live Composio contract" };
  if (!env.COMPOSIO_API_KEY) return { skipReason: "LIVE_COMPOSIO=1 but COMPOSIO_API_KEY missing" };
  return { settings: { apiKey: env.COMPOSIO_API_KEY } };
}

/**
 * Composio wrapper contract (§14.1, §14.3, §17). It proves discovery bounds, trusted identity
 * injection, generation checks, no-retry writes, normalized failures and log redaction. The live
 * target is intentionally metadata-only: a real connector action is never sent by this suite.
 */
export function describeComposioWrapperContract(target: ComposioContractTarget): void {
  const title = `Composio wrapper contract: ${target.name}${target.skipReason ? ` (skipped: ${target.skipReason})` : ""}`;
  describe.skipIf(target.skipReason !== undefined)(title, { timeout: target.testTimeoutMs }, () => {
    let subject: ComposioContractSubject | undefined;

    beforeEach(async () => {
      subject = target.create ? await target.create() : undefined;
    }, target.testTimeoutMs);

    afterEach(() => {
      if (!subject) return;
      const marker = subject.marker ?? "symplist-private-marker";
      for (const line of subject.logLines?.() ?? []) expect(line).not.toContain(marker);
    });

    it.skipIf(target.create === undefined)(
      "discovers only explicit action slugs and bounds schema requests",
      async () => {
        const current = subject as ComposioContractSubject;
        const result = await current.searchTools("synthetic contract query");
        expect(result).toBeTypeOf("object");
        await expect(current.getToolSchemas([])).rejects.toMatchObject({
          code: "integration.invalid_arguments",
        });
        await expect(
          current.getToolSchemas(Array.from({ length: 21 }, () => "TEST_TOOL")),
        ).rejects.toMatchObject({ code: "integration.invalid_arguments" });
      },
    );

    it.skipIf(target.create === undefined)(
      "normalizes provider failures without retaining provider bodies",
      async () => {
        if (!subject?.failureProbe) return;
        try {
          await subject.failureProbe();
          throw new Error("Expected the provider failure probe to reject");
        } catch (error) {
          expect(error).toMatchObject({
            code: subject.expectedFailureCode ?? "integration.provider_failed",
          });
          expect(JSON.stringify(error)).not.toContain(subject.marker ?? "private-marker");
        }
      },
    );

    it.skipIf(target.create === undefined)(
      "strips model identity selectors and injects the trusted account without retrying a write",
      async () => {
        const current = subject as ComposioContractSubject;
        const marker = current.marker ?? "symplist-private-marker";
        const input = {
          recipient: marker,
          user_id: "foreign-user",
          account: "foreign-account",
          connected_account_id: "foreign-connection",
          nested: { session_id: "foreign-session", keep: true },
        };
        const action = await current.resolveAction({ slug: "GMAIL_SEND_EMAIL", arguments: input });
        expect(action.arguments).toEqual({ recipient: marker, nested: { keep: true } });
        expect(input.account).toBe("foreign-account");
        await current.executeResolved(action, { sideEffect: true });
        const execution = current.executions().at(-1);
        expect(execution).toMatchObject({ client: "raw", maxRetries: 0, attempts: 1 });
        expect(execution?.account).toBe(action.connection.connectedAccountId);
      },
    );

    it.skipIf(target.create === undefined)(
      "rejects forged actions and invalid schemas with stable integration codes",
      async () => {
        const current = subject as ComposioContractSubject;
        await expect(
          current.resolveAction({ slug: "GMAIL_SEND_EMAIL", arguments: { recipient: 42 } }),
        ).rejects.toMatchObject({ code: "integration.invalid_arguments" });
        await expect(
          current.executeResolved(
            {
              tool: { slug: "GMAIL_SEND_EMAIL", toolkit: "gmail", schema: {} },
              connection: {
                id: "forged",
                ownerId: "owner",
                toolkit: "gmail",
                connectedAccountId: "ca_forged",
                generation: 1,
              },
              arguments: {},
            },
            { sideEffect: true },
          ),
        ).rejects.toMatchObject({ code: "integration.tool_unavailable" });
      },
    );

    it.skipIf(target.liveProbe === undefined)(
      "uses a bounded content-free live probe and never executes a connector action",
      async () => {
        await target.liveProbe?.();
      },
    );
  });
}
