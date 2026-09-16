"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWorkspace, useWorkspaceUi } from "./workspace-provider.tsx";

/**
 * The workspace's confirmations (task_actions.md, decision P1): completing a parent with open
 * subtasks (Complete all / Only the parent / Cancel) and completing a task Simon is still working on.
 * One host renders whichever one is open, so a list row, the task page header and a keyboard shortcut
 * all ask the same question. Cancel holds focus, and Escape or Cancel changes nothing.
 */
export function WorkspaceDialogs() {
  const { ui } = useWorkspace();
  const dialog = useWorkspaceUi((state) => state.dialog);
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Dialog
      open={dialog !== null}
      onOpenChange={(open) => {
        if (!open) ui.closeDialog();
      }}
    >
      {dialog ? (
        <DialogContent initialFocus={cancelRef} aria-labelledby={undefined}>
          <DialogTitle>{dialog.title}</DialogTitle>
          <DialogDescription>{dialog.description}</DialogDescription>
          {dialog.items && dialog.items.length > 0 ? (
            <ul className="sym-dialog-list">
              {dialog.items.slice(0, 8).map((item) => (
                <li key={item}>{item}</li>
              ))}
              {dialog.items.length > 8 ? <li>{`…and ${dialog.items.length - 8} more`}</li> : null}
            </ul>
          ) : null}
          <DialogActions>
            <Button ref={cancelRef} variant="secondary" size="lg" onClick={() => ui.closeDialog()}>
              {dialog.cancelLabel ?? "Cancel"}
            </Button>
            {dialog.alt && dialog.altLabel ? (
              <Button variant="secondary" size="lg" onClick={dialog.alt}>
                {dialog.altLabel}
              </Button>
            ) : null}
            <Button variant="primary" size="lg" onClick={dialog.confirm}>
              {dialog.confirmLabel}
            </Button>
          </DialogActions>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
