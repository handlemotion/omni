"use client";

// Ported from transitive (`packages/ui/src/components/ui/dialog.tsx`) onto React Aria: a flat
// black scrim (no blur), a white card with a 1px line and no shadow, 16px in, that fades and
// grows from 95% in 100ms, and a footer that is an action rail along its bottom edge. Dialogs
// stack: one opened from another dims the one below again.
import { XMarkIcon } from "@heroicons/react/16/solid";
import { cn } from "cn";
import {
  DialogTrigger as DialogTriggerPrimitive,
  Dialog as PrimitiveDialog,
  type DialogProps as DialogPrimitiveProps,
} from "react-aria-components/Dialog";
import { Heading, type HeadingProps } from "react-aria-components/Heading";
import { Modal, ModalOverlay, type ModalOverlayProps } from "react-aria-components/Modal";
import { Button, type ButtonProps } from "./button";

export const DialogTrigger = DialogTriggerPrimitive;

const sizes = {
  "2xs": "sm:max-w-2xs",
  xs: "sm:max-w-xs",
  sm: "sm:max-w-sm",
  md: "sm:max-w-md",
  lg: "sm:max-w-lg",
  xl: "sm:max-w-xl",
  "2xl": "sm:max-w-2xl",
  "3xl": "sm:max-w-3xl",
  "4xl": "sm:max-w-4xl",
  "5xl": "sm:max-w-5xl",
  // The whole screen: no scrim to see through, no edge. It settles from 105% while the app
  // under it recedes (the caller scales the app), so it reads as a layer stacked on top.
  full: "h-dvh max-h-none rounded-none border-0",
};

export interface DialogProps
  extends
    Omit<ModalOverlayProps, "children">,
    Pick<DialogPrimitiveProps, "aria-label" | "aria-labelledby" | "role" | "children"> {
  size?: keyof typeof sizes;
  closeButton?: boolean;
  /** No padding or gap: the content lays itself out (the settings dialog). */
  bare?: boolean;
}

export function Dialog({
  className,
  isDismissable,
  children,
  size = "xl",
  role = "dialog",
  closeButton = true,
  bare = false,
  ...props
}: DialogProps) {
  const dismissable = isDismissable ?? role !== "alertdialog";
  const full = size === "full";
  return (
    <ModalOverlay
      data-slot="dialog-overlay"
      isDismissable={dismissable}
      className={cn(
        "fixed inset-0 z-50 flex items-center justify-center",
        full
          ? // An identity animation of the panel's length: React Aria keeps the overlay (and so
            // the panel's exit) mounted only while the overlay itself animates.
            "entering:animate-in exiting:animate-out entering:duration-300 exiting:duration-200 motion-reduce:animate-none"
          : "entering:animate-in entering:fade-in-0 exiting:animate-out exiting:fade-out-0 bg-scrim p-4 duration-100 motion-reduce:animate-none",
      )}
      {...props}
    >
      <Modal
        data-slot="dialog-content"
        className={cn(
          "relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden rounded-xl border border-border bg-background text-sm text-foreground outline-hidden",
          "entering:animate-in entering:fade-in-0 exiting:animate-out exiting:fade-out-0 motion-reduce:animate-none",
          full
            ? "entering:zoom-in-105 exiting:zoom-out-105 ease-out entering:duration-300 exiting:duration-200"
            : "entering:zoom-in-95 exiting:zoom-out-95 duration-100",
          sizes[size],
          className,
        )}
      >
        <PrimitiveDialog
          aria-label={props["aria-label"]}
          aria-labelledby={props["aria-labelledby"]}
          role={role}
          data-slot="dialog"
          className={cn("flex min-h-0 flex-1 flex-col outline-hidden", !bare && "gap-4 p-4")}
        >
          {(values) => (
            <>
              {typeof children === "function" ? children(values) : children}
              {closeButton && dismissable && (
                <DialogCloseIcon filled={full} className={full ? "top-4 right-4" : undefined} />
              )}
            </>
          )}
        </PrimitiveDialog>
      </Modal>
    </ModalOverlay>
  );
}

/** Title and description; room on the right for the close button. */
export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 pe-10", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: HeadingProps) {
  return (
    <Heading
      slot="title"
      className={cn("m-0 text-sm/5 font-medium text-foreground", className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="description"
      className={cn("m-0 text-sm/5 text-pretty text-muted-foreground", className)}
      {...props}
    />
  );
}

/** The part that scrolls when the content is taller than the screen. */
export function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("flex min-h-0 flex-1 flex-col overflow-auto", className)}
      {...props}
    />
  );
}

/** An action rail: the dialog's whole bottom edge, set apart by a line and the surface fill. */
export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 mt-2 -mb-4 flex flex-col-reverse gap-1.5 border-t border-border bg-surface p-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

export function DialogClose({ intent = "outline", ref, ...props }: ButtonProps) {
  return <Button slot="close" ref={ref} intent={intent} {...props} />;
}

/** The ✕ in the top-right corner, 10px from both edges; on a full-screen dialog a grey disc
 *  16px in. */
export function DialogCloseIcon({
  className,
  isDismissable = true,
  filled = false,
}: {
  className?: string;
  isDismissable?: boolean;
  /** A grey disc behind the ✕: for a full-screen dialog, where a bare ✕ reads as a stray glyph. */
  filled?: boolean;
}) {
  if (!isDismissable) return null;
  return (
    <Button
      slot="close"
      intent={filled ? "secondary" : "plain"}
      size="sq-xs"
      isCircle={filled}
      aria-label="Close"
      className={cn("absolute top-2.5 right-2.5", filled && "border-0", className)}
    >
      <XMarkIcon />
    </Button>
  );
}
