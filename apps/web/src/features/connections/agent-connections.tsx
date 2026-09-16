"use client";

import { type McpGrantView, type McpScope, mcpCreateKeySchema } from "@symplist/contracts";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/features/access/session";
import { copyText } from "@/features/access/ui/clipboard";
import { TextField } from "@/features/access/ui/field";
import { useNavigationGuard } from "@/features/access/ui/navigation-guard";
import { Notice } from "@/features/access/ui/notice";
import { type KeyResult, useConnectionsEnvironment } from "./api.tsx";
import { useConnectionResource } from "./resource.ts";
import { TaskScope } from "./task-scope.tsx";
import { useIntent } from "./use-intent.ts";

export const permissionLabels: Record<McpScope, string> = {
  "tasks:read": "Read tasks and pages",
  "tasks:write": "Edit tasks and pages",
  "ai:run": "Start Simon work",
};
export function AgentConnections() {
  const session = useSession();
  return <Agents key={`${session.user?.id}:${session.access?.accessGeneration}`} />;
}

export function grantStatus(grant: McpGrantView, now = Date.now()): string {
  return grant.revokedAt !== null ? "Revoked" : grant.expiresAt <= now ? "Expired" : "Connected";
}
function date(value: number) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function Agents() {
  const { api } = useConnectionsEnvironment();
  const resource = useConnectionResource(api.grants);
  const [adding, setAdding] = useState(false);
  const [revoking, setRevoking] = useState<McpGrantView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const revokeButton = useRef<HTMLButtonElement | null>(null);
  const intent = useIntent(api.revoke, () => {
    setRevoking(null);
    setNotice("Agent connection revoked. Future requests are refused.");
    resource.refresh();
  });
  const refresh = resource.refresh;
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, [refresh]);
  return (
    <section className="sym-connections" aria-label="Agent connections">
      <header>
        <h1>Agent connections</h1>
        <p>Let another agent work with selected Symplist tasks.</p>
      </header>
      <p className="sym-connection-help">
        Use this MCP server in your agent's connection settings. Service accounts used by Simon are
        managed separately in Connections. These credentials never bypass beta access or owner-only
        approvals.
      </p>
      {resource.loading && (
        <p role="status">
          {resource.data ? "Refreshing agent connections…" : "Loading agent connections…"}
        </p>
      )}
      {resource.error && (
        <Notice tone="error" actions={<Button onClick={refresh}>Try again</Button>}>
          {resource.error}
        </Notice>
      )}
      {notice && <p role="status">{notice}</p>}
      {resource.data && (
        <>
          <div className="sym-connections">
            <TextField label="MCP server address" readOnly value={resource.data.server} />
            <Button
              onClick={() => {
                void copyText(resource.data?.server ?? "").then((ok) => {
                  setCopied(ok);
                  setCopyFailed(!ok);
                });
              }}
            >
              {copied ? "Server address copied" : "Copy server address"}
            </Button>
            {copyFailed && (
              <Notice tone="error">
                Clipboard access failed. Select the server address and copy it manually.
              </Notice>
            )}
          </div>
          <div>
            <Button ref={addButton} variant="primary" onClick={() => setAdding(true)}>
              Add connection
            </Button>
          </div>
          {!resource.data.grants.length && (
            <p>No agent connections yet. Add one only for an agent you trust.</p>
          )}
          <ul className="sym-connection-list" aria-label="Authorized agents">
            {resource.data.grants.map((grant) => (
              <li key={grant.id}>
                <div className="sym-connection-description">
                  <strong>{grant.name}</strong>
                  <span>
                    {grant.kind === "oauth" ? "OAuth" : "API key"} · {grantStatus(grant)}
                  </span>
                  <span>
                    {grant.taskIds === null
                      ? "All current and future tasks"
                      : `${grant.taskIds.length} selected tasks`}
                  </span>
                  <span>{grant.scopes.map((scope) => permissionLabels[scope]).join(" · ")}</span>
                  <span>
                    Created {date(grant.createdAt)} ·{" "}
                    {grant.lastUsedAt ? `Last used ${date(grant.lastUsedAt)}` : "Not used yet"} ·
                    Expires {date(grant.expiresAt)}
                  </span>
                </div>
                {grant.revokedAt === null && (
                  <Button
                    aria-label={`Revoke ${grant.name}`}
                    onClick={(event) => {
                      intent.reset();
                      revokeButton.current = event.currentTarget;
                      setRevoking(grant);
                    }}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {adding && (
        <CreateAgentKey
          finalFocus={addButton}
          onClose={() => {
            setAdding(false);
            refresh();
          }}
        />
      )}
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !intent.busy) setRevoking(null);
        }}
        finalFocus={revokeButton}
        title={`Revoke ${revoking?.name ?? "agent"}?`}
        description="This agent will no longer be able to use this connection. Previously completed work is not undone. You can create a new connection later."
        confirmLabel={intent.busy ? "Revoking…" : "Revoke connection"}
        busy={intent.busy}
        onConfirm={() => {
          if (revoking) void intent.run(revoking.id);
        }}
      >
        {intent.error && (
          <Notice tone="error">{intent.error} Retry checks this same revocation.</Notice>
        )}
      </ConfirmDialog>
    </section>
  );
}

function CreateAgentKey({
  finalFocus,
  onClose,
}: {
  finalFocus: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { api } = useConnectionsEnvironment();
  const [name, setName] = useState("");
  const [taskIds, setTaskIds] = useState<string[] | null>([]);
  const [scopes, setScopes] = useState<McpScope[]>(["tasks:read"]);
  const [validation, setValidation] = useState<string | null>(null);
  const [result, setResult] = useState<KeyResult | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [leave, setLeave] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const secret = result?.secretUnavailable === false ? result.key : undefined;
  const guard = useNavigationGuard(Boolean(secret), {
    title: "Leave before saving the key?",
    description: "The full key is shown only once. A lost key must be revoked and replaced.",
    confirmLabel: "Leave anyway",
    cancelLabel: "Stay and copy",
  });
  const intent = useIntent(api.createKey, setResult);
  const revoke = useIntent(api.revoke, () => {
    setResult(null);
    setReplacing(false);
    intent.reset();
  });
  const close = () => {
    if (intent.busy || revoke.busy) return;
    if (secret) setLeave(true);
    else onClose();
  };
  const submit = () => {
    const parsed = mcpCreateKeySchema.safeParse({ name, taskIds, scopes });
    if (!parsed.success) {
      setValidation(
        !name.trim()
          ? "Name this connection."
          : taskIds?.length === 0
            ? "Select at least one task or explicitly choose all tasks."
            : "Choose valid permissions and no more than 100 tasks.",
      );
      return;
    }
    setValidation(null);
    void intent.run(parsed.data);
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent className="sym-connection-sheet" finalFocus={finalFocus}>
          <DialogTitle>{result ? "Your agent connection" : "Add agent connection"}</DialogTitle>
          <DialogDescription>
            {result
              ? "Save this key in your agent's secure connection settings. It expires after 30 days."
              : "Create a named API key, or use your agent's OAuth connection flow. Select only the access it needs."}
          </DialogDescription>
          {result ? (
            secret ? (
              <>
                <Notice tone="warning" title="Shown once" live="none">
                  The full key is not stored by Symplist and cannot be shown again. Do not paste it
                  into Simon or a task page.
                </Notice>
                <TextField
                  label="One-time API key"
                  type={reveal ? "text" : "password"}
                  value={secret}
                  readOnly
                  autoComplete="off"
                  spellCheck={false}
                />
                <div className="sym-connection-row">
                  <Button onClick={() => setReveal(!reveal)}>
                    {reveal ? "Hide key" : "Reveal key"}
                  </Button>
                  <Button
                    onClick={() => {
                      void copyText(secret).then((ok) => {
                        setCopied(ok);
                        setCopyFailed(!ok);
                      });
                    }}
                  >
                    {copied ? "Key copied" : "Copy key"}
                  </Button>
                </div>
                {copyFailed && (
                  <Notice tone="error">
                    Clipboard access failed. Reveal the key and copy it manually.
                  </Notice>
                )}
                <p className="sym-connection-help">
                  Use the MCP server address with Authorization: Bearer &lt;your key&gt;. Never
                  place a key in a URL.
                </p>
                <DialogActions>
                  <Button variant="primary" onClick={close}>
                    Done — close key display
                  </Button>
                </DialogActions>
              </>
            ) : (
              <>
                <Notice tone="warning" title="Key already issued">
                  The earlier request created this connection, but the key cannot be recovered.
                  Revoke it and create a replacement.
                </Notice>
                {revoke.error && <Notice tone="error">{revoke.error}</Notice>}
                <DialogActions>
                  <Button onClick={close}>Close</Button>
                  <Button
                    variant="primary"
                    disabled={revoke.busy}
                    onClick={() => setReplacing(true)}
                  >
                    Revoke and replace
                  </Button>
                </DialogActions>
              </>
            )
          ) : (
            <form
              className="sym-connections"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <fieldset
                className="sym-connection-fields"
                disabled={intent.busy || intent.uncertain}
              >
                <TextField
                  label="Connection name"
                  maxLength={120}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="My research agent"
                />
                <TaskScope value={taskIds} onChange={setTaskIds} />
                <Permissions value={scopes} onChange={setScopes} />
              </fieldset>
              {validation && <Notice tone="error">{validation}</Notice>}
              {intent.error && (
                <Notice tone="error">
                  {intent.error} Check the same request before creating another key.
                </Notice>
              )}
              <DialogActions>
                <Button onClick={close} disabled={intent.busy}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" disabled={intent.busy}>
                  {intent.busy
                    ? "Creating…"
                    : intent.uncertain
                      ? "Check creation result"
                      : "Create API key"}
                </Button>
              </DialogActions>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={leave}
        onOpenChange={setLeave}
        title="Close the one-time key?"
        description="Save the key first. Closing removes it from this page; a lost key must be revoked and replaced."
        confirmLabel="I saved it — close"
        onConfirm={() => {
          setResult(null);
          onClose();
        }}
      />
      <ConfirmDialog
        open={replacing}
        onOpenChange={setReplacing}
        title="Revoke the inaccessible key?"
        description="The old connection will stop working. You can then review and create a replacement with a new key."
        confirmLabel={revoke.busy ? "Revoking…" : "Revoke old key"}
        busy={revoke.busy}
        onConfirm={() => {
          if (result) void revoke.run(result.id);
        }}
      >
        {revoke.error && (
          <Notice tone="error">{revoke.error} Retry checks this same revocation.</Notice>
        )}
      </ConfirmDialog>
      {guard.dialog}
    </>
  );
}

export function Permissions({
  value,
  onChange,
}: {
  value: McpScope[];
  onChange: (value: McpScope[]) => void;
}) {
  const choices: McpScope[] = ["tasks:read", "tasks:write", "ai:run"];
  return (
    <fieldset className="sym-connection-fields">
      <legend>Permissions</legend>
      {choices.map((scope) => (
        <label key={scope}>
          <input
            type="checkbox"
            checked={value.includes(scope)}
            onChange={(event) =>
              onChange(
                event.target.checked ? [...value, scope] : value.filter((item) => item !== scope),
              )
            }
          />{" "}
          {permissionLabels[scope]}
        </label>
      ))}
      <p className="sym-connection-help">
        Editing also permits reading, moving and scheduling tasks, and revoking artifact links.
        Starting Simon work never permits this agent to approve an action.
      </p>
    </fieldset>
  );
}
