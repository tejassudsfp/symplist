"use client";

import type { ConnectionStart, ConnectionView } from "@symplist/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSession } from "@/features/access/session";
import { TextField } from "@/features/access/ui/field";
import { Notice } from "@/features/access/ui/notice";
import { useQueryParam } from "@/features/access/ui/use-query-param";
import { workspaceRealtimeSource } from "@/features/workspace/realtime";
import { type Catalogue, hostedAuthorizationUrl, useConnectionsEnvironment } from "./api.tsx";
import { useConnectionResource } from "./resource.ts";
import { ConnectionReturnTask } from "./return-context.tsx";
import { useIntent } from "./use-intent.ts";

type Toolkit = Catalogue["items"][number];

export function ServiceConnections({ compact = false }: { compact?: boolean }) {
  const session = useSession();
  return (
    <Services key={`${session.user?.id}:${session.access?.accessGeneration}`} compact={compact} />
  );
}

function Services({ compact }: { compact: boolean }) {
  const { api, realtime } = useConnectionsEnvironment();
  const resource = useConnectionResource(api.list);
  const [browse, setBrowse] = useState(compact);
  const [selected, setSelected] = useState<ConnectionView | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const manageFocus = useRef<HTMLButtonElement | null>(null);
  const result = useQueryParam("result");
  const source = useMemo(
    () => (realtime === undefined ? workspaceRealtimeSource() : realtime),
    [realtime],
  );
  const refresh = resource.refresh;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, 250);
    };
    const off = source?.subscribeUser({
      onEvent: (event) => {
        if (event.type === "connection.status_changed") schedule();
      },
      onSnapshot: schedule,
    });
    return () => {
      off?.();
      if (timer !== null) clearTimeout(timer);
    };
  }, [source, refresh]);
  const connections = resource.data?.connections ?? [];
  const active = connections.filter((connection) => connection.status !== "disconnected");
  return (
    <section
      className="sym-connections"
      aria-label={compact ? "Optional service connections" : "Service connections"}
    >
      {!compact && (
        <header>
          <h1>Connections</h1>
          <p>Connect the services Simon may use on your behalf.</p>
        </header>
      )}
      {result === "connected" && (
        <Notice tone="info">
          The connection was confirmed. Pending actions still need your review.
        </Notice>
      )}
      {result === "cancelled" && (
        <Notice tone="info">
          Authorization was cancelled. You can try again whenever you're ready.
        </Notice>
      )}
      {result === "failed" && (
        <Notice tone="error">
          The provider connection could not be confirmed. Try connecting again.
        </Notice>
      )}
      {status && <p role="status">{status}</p>}
      {resource.loading && (
        <p role="status">{resource.data ? "Refreshing connections…" : "Loading connections…"}</p>
      )}
      {resource.error && (
        <Notice tone="error" actions={<Button onClick={refresh}>Try again</Button>}>
          {resource.error}
        </Notice>
      )}
      {resource.data?.enabled === false && (
        <Notice tone="info" title="No connectors are set up here yet">
          You can continue using tasks, pages and Simon without a connected service.
        </Notice>
      )}
      {resource.data && (
        <>
          {!compact && <h2>Connected</h2>}
          {!active.length && !compact && (
            <p>No connected accounts yet. Choose a service below when you need it.</p>
          )}
          <ul className="sym-connection-list" aria-label="Connected accounts">
            {active.map((connection) => (
              <li key={connection.id}>
                <div className="sym-connection-mark" aria-hidden="true">
                  {connection.toolkit.slice(0, 1).toUpperCase()}
                </div>
                <div className="sym-connection-description">
                  <strong>{connection.alias || connection.toolkit}</strong>
                  <span>
                    {connection.toolkit} ·{" "}
                    {connection.status === "active" ? "Connected" : "Needs attention"}
                  </span>
                  <span>Simon can use this account's authorized capabilities.</span>
                  <span>Account {connection.id.slice(-8)}</span>
                </div>
                <Button
                  aria-label={`Manage ${connection.alias || connection.toolkit}`}
                  onClick={(event) => {
                    manageFocus.current = event.currentTarget;
                    setSelected(connection);
                  }}
                >
                  Manage
                </Button>
              </li>
            ))}
          </ul>
          {resource.data.enabled &&
            (!browse ? (
              <Button onClick={() => setBrowse(true)}>Browse available services</Button>
            ) : (
              <CatalogueBrowser compact={compact} connections={active} />
            ))}
          {!compact && connections.some((connection) => connection.status === "disconnected") && (
            <details>
              <summary>Disconnected accounts</summary>
              <ul className="sym-connection-list">
                {connections
                  .filter((connection) => connection.status === "disconnected")
                  .map((connection) => (
                    <li key={connection.id}>
                      {connection.alias || connection.toolkit} · Disconnected
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </>
      )}
      <ConnectionReturnTask />
      {selected && (
        <ManageConnection
          connection={selected}
          finalFocus={manageFocus}
          onClose={() => setSelected(null)}
          onDisconnected={() => {
            setSelected(null);
            setStatus("Account disconnected. Future actions using it are stopped.");
            refresh();
          }}
        />
      )}
    </section>
  );
}

function CatalogueBrowser({
  compact,
  connections,
}: {
  compact: boolean;
  connections: readonly ConnectionView[];
}) {
  const { api } = useConnectionsEnvironment();
  const catalogue = useConnectionResource(api.catalogue);
  const [query, setQuery] = useState("");
  const [all, setAll] = useState(!compact);
  const [selected, setSelected] = useState<Toolkit | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const items = catalogue.data?.items ?? [];
  const matches = items.filter((item) =>
    `${item.name} ${item.slug} ${item.description}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const visible = all ? matches.slice(0, 100) : matches.slice(0, 4);
  return (
    <section className="sym-connections" aria-label="Available services">
      {!compact && <h2>Available</h2>}
      {(all || items.length > 4) && (
        <TextField
          label="Search services"
          data-surface-find="true"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setAll(true);
          }}
        />
      )}
      {catalogue.loading && <p role="status">Loading available services…</p>}
      {catalogue.error && (
        <Notice tone="error" actions={<Button onClick={catalogue.refresh}>Retry catalogue</Button>}>
          {catalogue.error}
        </Notice>
      )}
      {catalogue.data && !items.length && (
        <p>No services are available on this deployment. You can continue without one.</p>
      )}
      {items.length > 0 && !matches.length && <p>No services match “{query}”. Try another name.</p>}
      <ul className="sym-connection-list" aria-label="Service catalogue">
        {visible.map((item) => (
          <li key={item.slug}>
            <div className="sym-connection-mark" aria-hidden="true">
              {item.name.slice(0, 1)}
            </div>
            <div className="sym-connection-description">
              <strong>{item.name}</strong>
              <span>{item.description || "Use this service through Simon."}</span>
              {connections.some((connection) => connection.toolkit === item.slug) && (
                <span>Account connected · add another if needed</span>
              )}
            </div>
            <Button
              aria-label={`Connect ${item.name}`}
              onClick={(event) => {
                opener.current = event.currentTarget;
                setSelected(item);
              }}
            >
              Connect
            </Button>
          </li>
        ))}
      </ul>
      {!all && matches.length > 4 && (
        <Button onClick={() => setAll(true)}>Show more services</Button>
      )}
      {all && matches.length > 100 && (
        <p>Showing 100 of {matches.length} services. Search to narrow the list.</p>
      )}
      {selected && (
        <ConnectDialog toolkit={selected} finalFocus={opener} onClose={() => setSelected(null)} />
      )}
    </section>
  );
}

function ConnectDialog({
  toolkit,
  replacement,
  finalFocus,
  onClose,
}: {
  toolkit: Toolkit;
  replacement?: ConnectionView;
  finalFocus: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const { api, navigate } = useConnectionsEnvironment();
  const [alias, setAlias] = useState(replacement?.alias ?? "");
  const [unavailable, setUnavailable] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const intent = useIntent(api.start, (result) => {
    if (result.secretUnavailable || !result.url) {
      setUnavailable(true);
      return;
    }
    const url = hostedAuthorizationUrl(result.url);
    setLeaving(true);
    navigate(url);
  });
  const request = (): ConnectionStart => ({
    toolkit: toolkit.slug,
    ...(alias.trim() ? { alias: alias.trim() } : {}),
    ...(replacement ? { replacesConnectionId: replacement.id } : {}),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !intent.busy) onClose();
      }}
    >
      <DialogContent className="sym-connection-sheet" finalFocus={finalFocus}>
        <DialogTitle>
          {replacement ? "Reconnect" : "Connect"} {toolkit.name}
        </DialogTitle>
        <DialogDescription>
          Continue to the provider's secure authorization page. Symplist never asks for your
          provider password.
        </DialogDescription>
        <TextField
          label="Account label (optional)"
          description="For example, Personal or Work. Use labels to tell multiple accounts apart."
          maxLength={120}
          value={alias}
          disabled={intent.busy || intent.uncertain || leaving}
          onChange={(event) => setAlias(event.target.value)}
        />
        <p className="sym-connection-help">
          {toolkit.auth === "api_key"
            ? "The provider's hosted form will ask for your API key."
            : "Review the permissions on the provider's page before connecting."}{" "}
          Consequential actions may still require your confirmation.
        </p>
        {intent.error && (
          <Notice tone="error">
            {intent.error} Retry checks the same request; it does not start a second authorization.
          </Notice>
        )}
        {unavailable && (
          <Notice tone="warning">
            This authorization link was already issued and cannot be shown again. Start a new
            connection attempt; the old attempt expires automatically.
          </Notice>
        )}
        {leaving && (
          <p role="status">
            Opening provider authorization… If navigation did not open, close this dialog and start
            a new attempt.
          </p>
        )}
        <DialogActions>
          <DialogClose render={<Button disabled={intent.busy} />}>Back</DialogClose>
          <Button
            variant="primary"
            disabled={intent.busy || leaving}
            onClick={() => {
              if (unavailable) {
                intent.reset();
                setUnavailable(false);
              }
              void intent.run(request());
            }}
          >
            {intent.busy
              ? "Connecting…"
              : unavailable
                ? "Start new attempt"
                : intent.uncertain
                  ? "Check authorization result"
                  : "Continue to provider"}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}

function ManageConnection({
  connection,
  finalFocus,
  onClose,
  onDisconnected,
}: {
  connection: ConnectionView;
  finalFocus: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onDisconnected: () => void;
}) {
  const { api } = useConnectionsEnvironment();
  const [confirm, setConfirm] = useState(false);
  const [reconnect, setReconnect] = useState(false);
  const intent = useIntent(api.disconnect, onDisconnected);
  if (reconnect)
    return (
      <ConnectDialog
        toolkit={{
          slug: connection.toolkit,
          name: connection.toolkit,
          description: "",
          auth: "managed",
        }}
        replacement={connection}
        finalFocus={finalFocus}
        onClose={onClose}
      />
    );
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open && !intent.busy) onClose();
        }}
      >
        <DialogContent className="sym-connection-sheet" finalFocus={finalFocus}>
          <DialogTitle>{connection.alias || connection.toolkit}</DialogTitle>
          <DialogDescription>
            {connection.toolkit} ·{" "}
            {connection.status === "active"
              ? "Connected"
              : "Needs attention — reconnect before Simon can use this account."}
          </DialogDescription>
          <p className="sym-connection-help">
            Disconnecting stops future actions using this account. It cannot recall content already
            sent. Reconnecting never silently sends a pending action.
          </p>
          {intent.error && <Notice tone="error">{intent.error}</Notice>}
          <DialogActions>
            <DialogClose render={<Button />}>Close</DialogClose>
            <Button onClick={() => setReconnect(true)}>Reconnect</Button>
            <Button onClick={() => setConfirm(true)}>Disconnect</Button>
          </DialogActions>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Disconnect this account?"
        description="Future Simon actions using this account will stop. Content already sent is not recalled."
        confirmLabel={intent.busy ? "Disconnecting…" : "Disconnect account"}
        busy={intent.busy}
        onConfirm={() => {
          void intent.run(connection.id);
        }}
      >
        {intent.error && (
          <Notice tone="error">{intent.error} Retry checks this same disconnect.</Notice>
        )}
      </ConfirmDialog>
    </>
  );
}
