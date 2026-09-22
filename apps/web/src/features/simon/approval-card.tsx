"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { VaultGrantPicker } from "@/features/vault/grant-picker";
import { actionLabel, actionSummary, serviceLabel } from "./action-summary.ts";
import type { ChatState, SimonStore } from "./store.ts";

/** A vault handle is a bearer secret: the card names the grant and never the value behind it. */
function preview(value: unknown): string {
  return JSON.stringify(value, (key, item) => (key === "$vault" ? "Limited vault grant" : item), 2);
}
export function ApprovalCard({ state, store }: { state: ChatState; store: SimonStore }) {
  const approval = state.approval;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [vaultField, setVaultField] = useState("");
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!approval) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Math.min(approval.expiresAt - Date.now(), 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [approval]);
  if (!approval) return null;
  const disabled =
    state.busy || state.uncertain || approval.status !== "pending" || approval.expiresAt <= now;
  const summary = actionSummary(approval);
  const decide = (
    decision: "approve" | "deny" | "dismiss",
    editedArguments?: Record<string, unknown>,
  ) =>
    store.command(
      state.taskId,
      (key) =>
        store.api.decide(
          approval.id,
          {
            decision,
            argDigest: approval.argDigest,
            ...(editedArguments ? { editedArguments } : {}),
          },
          key,
        ),
      () => {
        setEditing(false);
        setVaultField("");
      },
    );
  const review = () => {
    try {
      const argumentsValue: unknown = JSON.parse(draft);
      if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue))
        throw new Error("object required");
      setError("");
      void decide("approve", argumentsValue as Record<string, unknown>);
    } catch {
      setError("Use a valid JSON object for the edited fields.");
    }
  };
  return (
    <section className="sym-simon-approval" aria-label="Action needs your approval">
      <h3>{summary.headline}</h3>
      {summary.subject ? (
        <p className="sym-simon-approval-line sym-simon-approval-subject">{summary.subject}</p>
      ) : null}
      {/* Which account acts is part of the decision, so it stays out in front of the fields. */}
      <p className="sym-simon-approval-line sym-simon-note">
        Using {approval.connectionAlias ? `${approval.connectionAlias} · ` : ""}
        {serviceLabel(approval.connectionToolkit)}
      </p>
      <p className="sym-simon-approval-line">
        Nothing is sent until you approve these exact details.
      </p>
      {approval.expiresAt <= now ? (
        <p className="sym-simon-approval-line" role="status">
          This action expired. Ask Simon to prepare it again.
        </p>
      ) : null}
      {/* Editing replaces the decision, because an edited payload is a different approval. */}
      {editing ? null : (
        <div className="sym-simon-actions">
          <Button variant="primary" disabled={disabled} onClick={() => void decide("approve")}>
            Approve action
          </Button>
          <Button disabled={disabled} onClick={() => void decide("deny")}>
            Don’t do this
          </Button>
        </div>
      )}
      {/* Closing the disclosure is a "never mind the fields" gesture; an edit left open inside it
          would hide every decision the card offers. */}
      <details
        className="sym-simon-approval-details"
        onToggle={(event) => {
          if (!event.currentTarget.open) setEditing(false);
        }}
      >
        <summary>Exact action fields</summary>
        {/* The disclosure names these fields, so the payload it opens on comes first. */}
        <textarea
          className="sym-simon-preview"
          aria-label="Exact action fields"
          value={preview(approval.arguments)}
          readOnly
          rows={8}
        />
        <dl>
          <dt>Action</dt>
          <dd>{actionLabel(approval.toolSlug, approval.connectionToolkit)}</dd>
          <dt>Connected account</dt>
          <dd>
            {approval.connectionAlias ?? serviceLabel(approval.connectionToolkit)}
            {approval.connectionAlias && approval.connectionToolkit
              ? ` · ${serviceLabel(approval.connectionToolkit)}`
              : null}
          </dd>
        </dl>
        <label className="sym-simon-approval-field">
          Action preview
          <textarea
            className="sym-simon-preview"
            value={preview(approval.preview)}
            readOnly
            rows={5}
          />
        </label>
        {editing ? (
          <div className="sym-simon-edit">
            <label>
              Edited action fields
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                disabled={state.busy || state.uncertain}
                rows={8}
              />
            </label>
            <p>Edits create a new review. They do not execute the action.</p>
            {error ? <p role="alert">{error}</p> : null}
            <Button disabled={disabled} onClick={review}>
              Review edited action
            </Button>
            <Button disabled={state.busy || state.uncertain} onClick={() => setEditing(false)}>
              Cancel edit
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => {
              setDraft(JSON.stringify(approval.arguments, null, 2));
              setEditing(true);
            }}
          >
            Edit draft
          </Button>
        )}
        {state.taskId && state.conversationId && !editing ? (
          <div className="sym-simon-vault">
            <label>
              Use a vault item for a field
              <select
                value={vaultField}
                disabled={disabled}
                onChange={(event) => setVaultField(event.target.value)}
              >
                <option value="">Choose an action field…</option>
                {Object.keys(approval.arguments).map((field) => (
                  <option key={field} value={field}>
                    {field}
                  </option>
                ))}
              </select>
            </label>
            {vaultField ? (
              <VaultGrantPicker
                context={{
                  taskId: state.taskId,
                  conversationId: state.conversationId,
                  toolSlug: approval.toolSlug,
                  argumentPath: vaultField,
                }}
                onCancel={() => setVaultField("")}
                onGranted={(handle) => {
                  void decide("approve", { ...approval.arguments, [vaultField]: handle });
                }}
              />
            ) : null}
          </div>
        ) : null}
      </details>
    </section>
  );
}
