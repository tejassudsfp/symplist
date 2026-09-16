"use client";

import type { CampaignRevocationPreview } from "@symplist/contracts";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { IdempotencyKeys } from "@/lib/api";
import { useAccessApi } from "../../api.ts";
import { problemOf } from "../../errors.ts";
import { formatDate } from "../../ui/format.ts";
import { Notice } from "../../ui/notice.tsx";
import { ReasonField, reasonMaxLength } from "../reason-field.tsx";

type Stage =
  | { readonly kind: "closed" }
  | { readonly kind: "loading" }
  | { readonly kind: "preview"; readonly preview: CampaignRevocationPreview }
  | { readonly kind: "done"; readonly revoked: number; readonly unchanged: number }
  | { readonly kind: "failed"; readonly message: string; readonly stale: boolean };

/**
 * Campaign grant revocation (§5.5, admin_accounts.md): the affected accounts are listed before
 * anything happens, and the confirmation is refused when that membership changed since the preview.
 * It takes access away from accounts admitted through this campaign; it never touches other accounts.
 */
export function CampaignRevocation({
  campaignId,
  label,
}: {
  campaignId: string;
  label?: string | null;
}) {
  const api = useAccessApi();
  const [stage, setStage] = useState<Stage>({ kind: "closed" });
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [keys] = useState(() => new IdempotencyKeys());

  const open = async () => {
    setStage({ kind: "loading" });
    setReason("");
    try {
      const preview = await api.previewCampaignRevocation(campaignId);
      setStage({ kind: "preview", preview });
    } catch (error) {
      const problem = problemOf(error);
      setStage({
        kind: "failed",
        stale: false,
        message:
          problem.kind === "network"
            ? "Symplist couldn't be reached. Try again."
            : "The affected accounts couldn't be listed. Try again.",
      });
    }
  };

  const confirm = async (preview: CampaignRevocationPreview) => {
    const text = reason.trim();
    if (text.length === 0 || text.length > reasonMaxLength) return;
    setBusy(true);
    try {
      const result = await api.confirmCampaignRevocation(
        campaignId,
        { previewDigest: preview.previewDigest, reason: text },
        keys.acquire(`campaign:${campaignId}:${preview.previewDigest}`),
      );
      keys.release(`campaign:${campaignId}:${preview.previewDigest}`);
      setStage({ kind: "done", revoked: result.revoked, unchanged: result.unchanged });
    } catch (error) {
      const problem = problemOf(error);
      const stale = problem.kind === "api" && problem.code === "admin.preview_stale";
      setStage({
        kind: "failed",
        stale,
        message: stale
          ? "The accounts in this campaign changed since the preview. Preview again to see the current list."
          : problem.kind === "network"
            ? "Symplist couldn't be reached, so nothing was revoked. Try again."
            : "Nothing was revoked. Try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const title = label ? `Revoke access from ${label}` : "Revoke campaign access";

  return (
    <>
      <Button
        size="lg"
        variant="danger"
        onClick={() => {
          void open();
        }}
      >
        Revoke campaign access…
      </Button>
      <Dialog
        open={stage.kind !== "closed"}
        onOpenChange={(next) => {
          if (!next) setStage({ kind: "closed" });
        }}
      >
        <DialogContent className="max-w-[520px]">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Accounts admitted through this batch of codes lose beta access. Running work is stopped
            where that is possible; anything already sent elsewhere can't be taken back.
          </DialogDescription>

          {stage.kind === "loading" ? (
            <p role="status" className="m-0 flex items-center gap-2 text-[13.5px] text-sym-muted">
              <Spinner size={12} />
              Checking who is affected…
            </p>
          ) : null}

          {stage.kind === "failed" ? (
            <Notice
              tone="error"
              actions={
                <Button
                  size="sm"
                  onClick={() => {
                    void open();
                  }}
                >
                  {stage.stale ? "Preview again" : "Try again"}
                </Button>
              }
            >
              {stage.message}
            </Notice>
          ) : null}

          {stage.kind === "done" ? (
            <Notice tone="success" title="Campaign access revoked">
              {`${stage.revoked} account${stage.revoked === 1 ? "" : "s"} relocked`}
              {stage.unchanged > 0
                ? `, ${stage.unchanged} already paused or deleted by the time it ran`
                : ""}
              .
            </Notice>
          ) : null}

          {stage.kind === "preview" ? (
            stage.preview.accounts.length === 0 ? (
              <Notice tone="info" live="none">
                No account currently has access from this campaign. There is nothing to revoke.
              </Notice>
            ) : (
              <>
                <p className="m-0 font-medium text-[13.5px]">
                  {stage.preview.accounts.length} account
                  {stage.preview.accounts.length === 1 ? "" : "s"} would lose access:
                </p>
                <ul className="m-0 max-h-[180px] list-none overflow-auto rounded-sym border border-sym-line p-2 text-[13px]">
                  {stage.preview.accounts.map((account) => (
                    <li key={account.grantId} className="flex justify-between gap-3 py-0.5">
                      <span className="truncate">{account.displayName ?? account.email}</span>
                      <span className="text-[12px] text-sym-muted">
                        since {formatDate(account.grantedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
                <ReasonField value={reason} onChange={setReason} disabled={busy} />
              </>
            )
          ) : null}

          <DialogActions>
            <Button
              variant="secondary"
              size="lg"
              disabled={busy}
              onClick={() => setStage({ kind: "closed" })}
            >
              {stage.kind === "done" ? "Close" : "Cancel"}
            </Button>
            {stage.kind === "preview" && stage.preview.accounts.length > 0 ? (
              <Button
                variant="primary"
                size="lg"
                disabled={busy || reason.trim().length === 0}
                aria-busy={busy || undefined}
                onClick={() => {
                  void confirm(stage.preview);
                }}
              >
                {busy ? <Spinner size={12} /> : null}
                {busy ? "Revoking…" : `Revoke access for ${stage.preview.accounts.length}`}
              </Button>
            ) : null}
          </DialogActions>
        </DialogContent>
      </Dialog>
    </>
  );
}
