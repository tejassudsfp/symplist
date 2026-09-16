"use client";

import { type OAuthDecision, oauthDecisionSchema, taskIdSchema } from "@symplist/contracts";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SessionGate, useSession } from "@/features/access/session";
import { EntryFrame } from "@/features/access/ui/entry-frame";
import { Notice } from "@/features/access/ui/notice";
import { useQueryParam } from "@/features/access/ui/use-query-param";
import { publicOrigins } from "@/lib/public-config";
import { permissionLabels } from "./agent-connections.tsx";
import { useConnectionsEnvironment } from "./api.tsx";
import { useConnectionResource } from "./resource.ts";
import { TaskScope } from "./task-scope.tsx";
import { useIntent } from "./use-intent.ts";

/** API-attested redirect; http is permitted only for the registered loopback native-client flow. */
export function oauthReturnUrl(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  )
    throw new Error("Invalid OAuth return address");
  return url.href;
}

export function OAuthConsent() {
  const request = useQueryParam("request");
  const session = useSession();
  const parsed = taskIdSchema.safeParse(request);
  return (
    <SessionGate require="admitted">
      <EntryFrame width="wide">
        {parsed.success ? (
          <Consent
            key={`${session.user?.id}:${session.access?.accessGeneration}:${parsed.data}`}
            id={parsed.data}
          />
        ) : (
          <Notice tone="error">
            This authorization request is missing or invalid. Return to your agent and start again.
          </Notice>
        )}
      </EntryFrame>
    </SessionGate>
  );
}

function Consent({ id }: { id: string }) {
  const { api, navigate } = useConnectionsEnvironment();
  const load = useCallback((signal: AbortSignal) => api.consent(id, signal), [api, id]);
  const resource = useConnectionResource(load);
  const [taskIds, setTaskIds] = useState<string[] | null>([]);
  const [validation, setValidation] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const intent = useIntent(
    (body: OAuthDecision, key, signal) => api.decide(id, body, key, signal),
    (result) => {
      if (result.secretUnavailable || !result.redirectUrl) {
        setDone(true);
        return;
      }
      navigate(oauthReturnUrl(result.redirectUrl));
      setDone(true);
    },
  );
  const [now, setNow] = useState(Date.now);
  const expiresAt = resource.data?.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [expiresAt]);
  const expired = expiresAt !== undefined && expiresAt <= now;
  const decide = (body: OAuthDecision) => {
    const parsed = oauthDecisionSchema.safeParse(body);
    if (!parsed.success) {
      setValidation("Select at least one task or explicitly choose all tasks.");
      return;
    }
    setValidation(null);
    void intent.run(parsed.data);
  };
  if (done)
    return (
      <section className="sym-connections">
        <h1>Authorization decided</h1>
        <p>
          This request cannot reveal its authorization code again. Return to your agent; if it did
          not connect, start a new connection there.
        </p>
        <Link href="/settings/agents">Manage agent connections</Link>
      </section>
    );
  return (
    <section className="sym-connections" aria-label="Authorize agent">
      <h1>Authorize agent access</h1>
      {resource.loading && <p role="status">Loading authorization request…</p>}
      {resource.error && (
        <Notice tone="error" actions={<Button onClick={resource.refresh}>Try again</Button>}>
          This request could not be opened. It may have expired, already been used, or belong to
          another sign-in session.
        </Notice>
      )}
      {resource.data && (
        <>
          <h2>{resource.data.clientName}</h2>
          {resource.data.unverified && (
            <Notice tone="warning" title="Unverified client" live="none">
              This client registered its own name. Symplist has not verified who operates it.
            </Notice>
          )}
          <p className="sym-connection-help">
            {resource.data.metadataHost
              ? `Client metadata: ${resource.data.metadataHost}. `
              : "No verified metadata host. "}
            Returns to: {resource.data.redirectHost}.
          </p>
          {resource.data.loopbackOnly && (
            <Notice tone="warning" live="none">
              This connection returns to a program running on your device. Continue only if you
              started it yourself.
            </Notice>
          )}
          <h3>Requested permissions</h3>
          <ul>
            {resource.data.scopes.map((scope) => (
              <li key={scope}>{permissionLabels[scope]}</li>
            ))}
          </ul>
          {resource.data.offlineAccess && (
            <p>
              This agent requests continued access while you're away, for up to 30 days. You can
              revoke it at any time.
            </p>
          )}
          <TaskScope
            value={taskIds}
            onChange={setTaskIds}
            disabled={intent.busy || intent.uncertain || expired}
          />
          <p className="sym-connection-help">
            Your Vault, service credentials and approval decisions are never shared. Simon actions
            still require your own approval where applicable.
          </p>
          {expired && (
            <Notice tone="warning">
              This request expired. Return to your agent to start a new connection.
            </Notice>
          )}
          {validation && <Notice tone="error">{validation}</Notice>}
          {intent.error && (
            <Notice tone="error">{intent.error} Retry checks your original decision.</Notice>
          )}
          <div className="sym-connection-row">
            {intent.uncertain ? (
              <Button
                disabled={intent.busy}
                onClick={() => {
                  void intent.run();
                }}
              >
                Check decision result
              </Button>
            ) : (
              <>
                <Button
                  disabled={intent.busy || expired}
                  onClick={() => decide({ decision: "deny" })}
                >
                  Deny
                </Button>
                <Button
                  variant="primary"
                  disabled={intent.busy || expired}
                  onClick={() => decide({ decision: "allow", taskIds })}
                >
                  {intent.busy ? "Deciding…" : "Allow selected access"}
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/** Fixed-origin bridge after sign-in. Untrusted client query values can never change its destination. */
export function authorizationBridgeUrl(apiOrigin: string, search: string): string {
  const url = new URL("/oauth/authorize", apiOrigin);
  url.search = search;
  return url.href;
}
export function OAuthAuthorizeBridge() {
  return (
    <SessionGate require="admitted">
      <AuthorizationBridge />
    </SessionGate>
  );
}
function AuthorizationBridge() {
  const { navigate } = useConnectionsEnvironment();
  const [failure, setFailure] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    const origin = publicOrigins().apiOrigin;
    if (!origin) {
      setFailure(true);
      return;
    }
    started.current = true;
    navigate(authorizationBridgeUrl(origin, window.location.search));
  }, [navigate]);
  return (
    <EntryFrame>
      {failure ? (
        <Notice tone="error">
          The API address is not configured. Return to your agent and contact this deployment's
          operator.
        </Notice>
      ) : (
        <p role="status">Opening authorization…</p>
      )}
    </EntryFrame>
  );
}
