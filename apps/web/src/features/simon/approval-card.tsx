"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { VaultGrantPicker } from "@/features/vault/grant-picker";
import type { ChatState, SimonStore } from "./store.ts";

function preview(value: unknown): string {
  return JSON.stringify(value, (key, item) => (key === "$vault" ? "Limited vault grant" : item), 2);
}
function words(value: string): string {
  const phrase = value.replaceAll(/[_-]+/g, " ").trim().toLocaleLowerCase();
  return phrase ? `${phrase[0]?.toLocaleUpperCase()}${phrase.slice(1)}` : "Connected service";
}
function actionLabel(toolSlug: string, toolkit: string | null): string {
  const prefix = toolkit ? `${toolkit}_` : "";
  return words(
    prefix && toolSlug.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())
      ? toolSlug.slice(prefix.length)
      : toolSlug,
  );
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
      <h3>Review this action</h3>
      <p>Nothing is sent until you approve these exact details.</p>
      <dl>
        <dt>Action</dt>
        <dd>{actionLabel(approval.toolSlug, approval.connectionToolkit)}</dd>
        <dt>Connected account</dt>
        <dd>
          {approval.connectionAlias ??
            (approval.connectionToolkit ? words(approval.connectionToolkit) : "Connected service")}
          {approval.connectionAlias && approval.connectionToolkit
            ? ` · ${words(approval.connectionToolkit)}`
            : null}
        </dd>
      </dl>
      <textarea
        className="sym-simon-preview"
        aria-label="Action preview"
        value={preview(approval.preview)}
        readOnly
        rows={5}
      />
      <details>
        <summary>Exact action fields</summary>
        <textarea
          className="sym-simon-preview"
          aria-label="Exact action fields"
          value={preview(approval.arguments)}
          readOnly
          rows={8}
        />
      </details>
      {approval.expiresAt <= now ? (
        <p role="status">This action expired. Ask Simon to prepare it again.</p>
      ) : null}
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
        <div className="sym-simon-actions">
          <Button variant="primary" disabled={disabled} onClick={() => void decide("approve")}>
            Approve action
          </Button>
          <Button disabled={disabled} onClick={() => void decide("deny")}>
            Don’t do this
          </Button>
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
        </div>
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
    </section>
  );
}
