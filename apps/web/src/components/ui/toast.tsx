import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { cn } from "cn";
import type { CSSProperties, ReactNode } from "react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

const MAX_TOAST_LENGTH = 160;
const NOTICE_DURATION_MS = 4_000;
const ERROR_DURATION_MS = 6_000;

type ToastId = string | number;

type ToastTone = "success" | "error" | "warning" | "info";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastTarget {
  id?: string;
}

interface NoticeOptions extends ToastTarget {
  /** A second, quieter line under the message. */
  description?: string;
  /** One inline action, e.g. Undo. Clicking it dismisses the toast. */
  action?: ToastAction;
  /** Milliseconds before the toast leaves. Defaults by tone. */
  duration?: number;
}

interface PromptOptions extends ToastTarget {
  tone?: ToastTone;
  description?: string;
  /** The committing action, e.g. Save. */
  primary: ToastAction;
  /** The backing-out action, e.g. Revert. */
  secondary?: ToastAction;
}

/**
 * Setup's toast (dorks' onboarding): Sonner's own toast, painted brand blue by `.setup-toaster` in
 * styles.css, instead of `ToastCard`. The same message twice replaces itself.
 */
export function setupToast(message: string, description?: string) {
  toast.error(message, { id: message, duration: ERROR_DURATION_MS, description });
}

export function Toaster({
  style,
  toastOptions,
  setup = false,
  ...props
}: ToasterProps & {
  /** Setup's toaster: brand-blue toasts with a close (see `setupToast`). */
  setup?: boolean;
}) {
  return (
    <Sonner
      className={cn("toaster group font-sans", setup && "setup-toaster")}
      closeButton={setup}
      {...(setup && { icons: { error: <XCircleIcon className="size-4" /> } })}
      duration={NOTICE_DURATION_MS}
      position="bottom-center"
      theme="light"
      style={{ "--width": "min(356px, calc(100vw - 2rem))", ...style } as CSSProperties}
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...toastOptions?.classNames,
          toast: cn("!w-(--width) !max-w-[calc(100vw-2rem)]", toastOptions?.classNames?.toast),
          content: cn("h-full", toastOptions?.classNames?.content),
          title: cn("h-full", toastOptions?.classNames?.title),
        },
      }}
      {...props}
    />
  );
}

const toneIconClassName = "aspect-square h-[1.56cap] w-auto shrink-0 translate-y-[0.28cap]";

const TONE_ICONS: Record<ToastTone, ReactNode> = {
  success: (
    <CheckCircleIcon aria-hidden className={cn(toneIconClassName, "text-primary-foreground")} />
  ),
  error: <XCircleIcon aria-hidden className={cn(toneIconClassName, "text-primary-foreground")} />,
  warning: (
    <ExclamationTriangleIcon
      aria-hidden
      className={cn(toneIconClassName, "text-primary-foreground")}
    />
  ),
  info: (
    <InformationCircleIcon
      aria-hidden
      className={cn(toneIconClassName, "text-primary-foreground")}
    />
  ),
};

function shorten(message: string) {
  const text = message.trim();
  return text.length <= MAX_TOAST_LENGTH ? text : `${text.slice(0, MAX_TOAST_LENGTH - 1)}…`;
}

function ToastButton(props: {
  action: ToastAction;
  emphasis: "primary" | "quiet";
  onDone?: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-6 shrink-0 cursor-pointer items-center rounded-sm px-2 text-sm leading-5 font-medium tracking-[-0.01em]",
        "outline-none focus-visible:inset-ring focus-visible:inset-ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        props.emphasis === "primary"
          ? "bg-primary-foreground text-primary-button hover:bg-primary-foreground/90"
          : "text-primary-foreground/80 hover:bg-primary-foreground/15 hover:text-primary-foreground",
      )}
      onClick={() => {
        props.action.onClick();
        props.onDone?.();
      }}
    >
      {props.action.label}
    </button>
  );
}

interface ToastCardProps {
  tone: ToastTone;
  message: string;
  description?: string | undefined;
  children?: ReactNode;
}

/**
 * The toast card, brand blue like setup's toasts (`.setup-toaster` in styles.css): white text and
 * icon on the primary button's blue, with no edge. Stacked behind the front toast, a card dims.
 *
 * Room, in ink: 8px above and below the 24px action (12px to the icon's shape and the text),
 * 12px from the left edge to the icon, 8px from the right edge to the action.
 */
export function ToastCard({ tone, message, description, children }: ToastCardProps) {
  return (
    <div
      data-slot="toast"
      data-tone={tone}
      className={cn(
        "relative flex h-full w-full flex-col overflow-hidden rounded-lg bg-primary-button text-primary-foreground transition-colors duration-200",
        "[[data-expanded=false][data-front=false]_&]:bg-[color-mix(in_oklab,var(--color-primary-button)_65%,var(--color-background))]",
      )}
    >
      <div
        className={cn(
          "flex flex-1 items-baseline gap-2.5 py-2 ps-3 pe-2 text-sm transition-opacity duration-200",
          "[[data-expanded=false][data-front=false]_&]:opacity-0",
        )}
      >
        {TONE_ICONS[tone]}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p
            data-slot="toast-message"
            className="line-clamp-3 text-sm leading-5 tracking-[-0.01em] text-pretty break-words"
          >
            {message}
          </p>
          {description && (
            <p
              data-slot="toast-description"
              className="line-clamp-2 text-sm leading-5 tracking-[-0.01em] break-words text-primary-foreground/85"
            >
              {description}
            </p>
          )}
        </div>
        {children && <div className="flex shrink-0 items-baseline gap-0.5">{children}</div>}
      </div>
    </div>
  );
}

function notice(tone: ToastTone, message: string, options: NoticeOptions = {}) {
  const duration = options.duration ?? (tone === "error" ? ERROR_DURATION_MS : NOTICE_DURATION_MS);
  return toast.custom(
    (id) => (
      <ToastCard
        tone={tone}
        message={shorten(message)}
        description={options.description ? shorten(options.description) : undefined}
      >
        {options.action && (
          <ToastButton action={options.action} emphasis="quiet" onDone={() => toast.dismiss(id)} />
        )}
      </ToastCard>
    ),
    { id: options.id, duration },
  ) satisfies ToastId;
}

/**
 * Product toasts. Every toast is a card in the page's theme:
 * - notices (`success`, `error`, `warning`, `message`) leave on their own;
 * - `prompt` stays until the caller dismisses it, with a primary and an optional secondary action.
 */
export const appToast = {
  success: (message: string, options?: NoticeOptions) => notice("success", message, options),
  error: (message: string, options?: NoticeOptions) => notice("error", message, options),
  warning: (message: string, options?: NoticeOptions) => notice("warning", message, options),
  message: (message: string, options?: NoticeOptions) => notice("info", message, options),

  /**
   * A persistent bar that asks for a decision, e.g. "2 unsaved changes · Revert · Save". Its
   * actions do not dismiss it: the caller calls `appToast.dismiss(id)` once the decision lands.
   */
  prompt(message: string, options: PromptOptions) {
    return toast.custom(
      () => (
        <ToastCard
          tone={options.tone ?? "info"}
          message={shorten(message)}
          description={options.description ? shorten(options.description) : undefined}
        >
          {options.secondary && <ToastButton action={options.secondary} emphasis="quiet" />}
          <ToastButton action={options.primary} emphasis="primary" />
        </ToastCard>
      ),
      { id: options.id, duration: Number.POSITIVE_INFINITY, dismissible: false },
    ) satisfies ToastId;
  },

  dismiss: (id?: ToastId) => void toast.dismiss(id),
};

export type { NoticeOptions, PromptOptions, ToastAction, ToastId, ToastTone };
