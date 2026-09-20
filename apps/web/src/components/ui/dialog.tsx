"use client";

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { type ComponentProps, type ReactNode, type RefObject, useRef } from "react";
import { ACTION_LAYER_ATTRIBUTE } from "@/actions/focus";
import { Button } from "./button.tsx";

/*
 * Accessible modal dialogs on Base UI: focus moves inside and is trapped, Escape and the backdrop
 * dismiss, and focus returns to the element that opened the dialog (system_states.md). The popup is a
 * modal action layer, so app and pane shortcuts stay inactive while it is open (§10.2).
 */

function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogContent({ className, children, ...props }: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className="sym-dialog-backdrop" />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        {...{ [ACTION_LAYER_ATTRIBUTE]: "modal" }}
        className={cn("sym-dialog", className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("sym-dialog-title", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("sym-dialog-description", className)}
      {...props}
    />
  );
}

function DialogActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div data-slot="dialog-actions" className={cn("sym-dialog-actions", className)} {...props} />
  );
}

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly onConfirm: () => void;
  /** Destructive or irreversible confirmations start focus on Cancel. */
  readonly initialFocus?: "confirm" | "cancel";
  readonly busy?: boolean;
  readonly finalFocus?: RefObject<HTMLElement | null>;
  readonly children?: ReactNode;
}

/** A confirmation dialog (alertdialog) with Cancel and a primary action, in the sample's layout. */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  initialFocus = "cancel",
  busy = false,
  finalFocus,
  children,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={initialFocus === "cancel" ? cancelRef : confirmRef}
        {...(finalFocus ? { finalFocus } : {})}
      >
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {children}
        <DialogActions>
          <DialogClose render={<Button ref={cancelRef} variant="secondary" size="lg" />}>
            {cancelLabel}
          </DialogClose>
          <Button
            ref={confirmRef}
            variant="primary"
            size="lg"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogActions>
      </DialogContent>
    </AlertDialogPrimitive.Root>
  );
}

export {
  ConfirmDialog,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
};
