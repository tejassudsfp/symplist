"use client";

import { BUG_REPORT_MAX_LENGTH } from "@symplist/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useOptionalSession } from "@/features/access/session";
import { type FeedbackApi, feedbackApi, reportFailure } from "./api.ts";
import { describeContext } from "./context.ts";

/**
 * Reporting a bug, from anywhere.
 *
 * One component for all three surfaces, because there is one thing to say and one place it goes: the
 * signed-in workspace mounts it from the profile menu, the public site from its footer, and the desktop
 * app gets it by loading the same workspace. Which api route it uses is decided by whether somebody is
 * signed in — the public one accepts a report from a visitor whose bug may be the reason they are not.
 *
 * The form is a box and a button on purpose. Nothing asks for a title, a category or a severity: the
 * person filing it is doing us a favour, and a field they have to think about is a report they do not
 * send. A failure keeps every character they typed, so retrying costs nothing.
 */
export interface ReportBugDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Injected by tests; defaults to the shared client. */
  readonly api?: FeedbackApi;
}

export function ReportBugDialog({ open, onOpenChange, api }: ReportBugDialogProps) {
  const signedIn = useOptionalSession()?.status === "signed_in";
  const [report, setReport] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const mounted = useRef(true);
  const fieldId = `${useId()}-report`;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Cleared once a sent report's dialog is closed, so reopening offers a blank box. A dialog closed
  // *without* sending keeps every character: dismissing it by accident mid-sentence must not cost the
  // sentence, and that is the same promise a failed send makes.
  useEffect(() => {
    if (open || !sent) return;
    setReport("");
    setFailure(null);
    setSent(false);
  }, [open, sent]);

  async function send(): Promise<void> {
    const text = report.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const client = api ?? feedbackApi();
      const body = { report: text, ...(await describeContext({ signedOut: !signedIn })) };
      if (signedIn) await client.report(body);
      else await client.reportAnonymously(body);
      if (mounted.current) setSent(true);
    } catch (error) {
      if (mounted.current) setFailure(reportFailure(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[520px]">
        <DialogTitle>{sent ? "Report sent" : "Report a bug"}</DialogTitle>
        {sent ? (
          <>
            <DialogDescription>
              Thank you — it is filed with the page you were on. Nothing else is needed from you.
            </DialogDescription>
            <DialogActions>
              <Button variant="primary" size="lg" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogActions>
          </>
        ) : (
          <>
            <DialogDescription>
              What happened? The page you are on is sent with it, so there is no need to describe
              where you were.
            </DialogDescription>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={fieldId} className="font-medium text-[13px] text-sym-text">
                What happened
              </label>
              <textarea
                id={fieldId}
                rows={5}
                value={report}
                disabled={busy}
                maxLength={BUG_REPORT_MAX_LENGTH}
                aria-invalid={failure ? true : undefined}
                onChange={(event) => setReport(event.target.value)}
                className="w-full rounded-sym border border-sym-line-strong bg-sym-surface px-3 py-2 text-base text-sym-text outline-none focus-visible:border-sym-accent focus-visible:shadow-[0_0_0_3px_var(--sym-accent-soft)] aria-[invalid=true]:border-sym-danger md:text-[14px]"
              />
            </div>
            {failure ? (
              <p role="alert" className="m-0 text-[13px] text-sym-danger">
                {failure}
              </p>
            ) : null}
            <DialogActions>
              <Button
                variant="secondary"
                size="lg"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="lg"
                disabled={busy || report.trim().length === 0}
                aria-busy={busy || undefined}
                onClick={() => {
                  void send();
                }}
              >
                {busy ? <Spinner size={12} /> : null}
                {busy ? "Sending…" : "Send report"}
              </Button>
            </DialogActions>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export interface ReportBugButtonProps {
  /** Styling for the surface it sits on; the footer passes its own link class. */
  readonly className?: string;
  readonly label?: string;
  readonly api?: FeedbackApi;
}

/**
 * A self-contained entry point: the control and the dialog it opens. This is what a footer, a page or a
 * menu-free surface mounts — one element, no state of its own to keep.
 */
export function ReportBugButton({ className, label = "Report a bug", api }: ReportBugButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="link" {...(className ? { className } : {})} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ReportBugDialog open={open} onOpenChange={setOpen} {...(api ? { api } : {})} />
    </>
  );
}
