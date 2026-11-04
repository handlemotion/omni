// Toasts, ported from transitive (`packages/ui/src/components/ui/toast.tsx` and `sonner.tsx`):
// a card in the page's own theme (the overlay tokens, like menus and popovers) with a tone icon,
// the message, an optional action and a countdown bar.
// Sonner owns placement, stacking, swipe and the close timer; `ToastCard` paints the toast.
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  XCircleIcon,
} from "@heroicons/react/20/solid";
import { cn } from "cn";
import { useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { Toaster as Sonner, toast, type ToasterProps } from "sonner";

const MAX_TOAST_LENGTH = 160;
const NOTICE_DURATION_MS = 4_000;
// Errors carry a fix, so they stay up long enough to read it.
const ERROR_DURATION_MS = 6_000;

type ToastId = string | number;

type ToastTone = "success" | "error" | "warning" | "info";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastTarget {
  /**
   * Reuse an id to replace a visible toast in place instead of stacking a new one.
   * A string, because Sonner reads a falsy id (`0`) as "no id" and dismisses every toast.
   */
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

/** Hosts the toasts: bottom right, 356px wide (the full width less a gutter on a phone). */
export function Toaster({ style, toastOptions, ...props }: ToasterProps) {
  return (
    <Sonner
      className="toaster group font-sans"
      closeButton={false}
      duration={NOTICE_DURATION_MS}
      position="bottom-right"
      theme="light"
      style={{ "--width": "min(356px, calc(100vw - 2rem))", ...style } as CSSProperties}
      toastOptions={{
        ...toastOptions,
        classNames: {
          ...toastOptions?.classNames,
          // No overflow-hidden: Sonner's expanded ::after fills the gap between stacked toasts;
          // clipping it makes hover flicker in the gaps.
          toast: cn("!w-(--width) !max-w-[calc(100vw-2rem)]", toastOptions?.classNames?.toast),
          content: cn("h-full", toastOptions?.classNames?.content),
          title: cn("h-full", toastOptions?.classNames?.title),
        },
      }}
      {...props}
    />
  );
}

// The glyphs draw a 16px shape in a 20px box. Flex baseline-aligns the box bottom, so shifting
// it down centres the shape on the capitals of the first line.
const toneIconClassName = "aspect-square h-[1.56cap] w-auto shrink-0 translate-y-[0.28cap]";

const TONE_ICONS: Record<ToastTone, ReactNode> = {
  success: <CheckCircleIcon aria-hidden className={cn(toneIconClassName, "text-success")} />,
  error: <XCircleIcon aria-hidden className={cn(toneIconClassName, "text-danger")} />,
  warning: (
    <ExclamationTriangleIcon aria-hidden className={cn(toneIconClassName, "text-warning")} />
  ),
  info: <InformationCircleIcon aria-hidden className={cn(toneIconClassName, "text-info")} />,
};

function shorten(message: string): string {
  const text = message.trim();
  return text.length <= MAX_TOAST_LENGTH ? text : `${text.slice(0, MAX_TOAST_LENGTH - 1)}…`;
}

function subscribeToVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Sonner pauses its close timer while the tab is hidden; the countdown bar follows it. */
function useDocumentHidden(): boolean {
  return useSyncExternalStore(
    subscribeToVisibility,
    () => document.hidden,
    () => false,
  );
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
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        props.emphasis === "primary"
          ? "bg-foreground text-background hover:bg-foreground/90"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
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
  /** Countdown length in milliseconds; omit for a toast that stays until it is resolved. */
  duration?: number;
  children?: ReactNode;
}

/**
 * The toast card, in the page's theme: the overlay fill, border and drop that menus use.
 *
 * Room, in ink: the icon's shape and the text sit 16px from the card's left and top edges (12px
 * padding, plus the glyph's 2px of air or the text line's slack), 16px from the bottom, and the
 * message and description are 2px apart.
 */
export function ToastCard({ tone, message, description, duration, children }: ToastCardProps) {
  const hidden = useDocumentHidden();
  return (
    <div
      data-slot="toast"
      data-tone={tone}
      className={cn(
        // h-full + overflow-hidden: a collapsed stack sizes every toast to the front one.
        "relative flex h-full w-full flex-col overflow-hidden bg-overlay text-overlay-foreground",
        "rounded-lg border border-border shadow-(--shadow-overlay)",
      )}
    >
      <div
        className={cn(
          // Baseline alignment: icon, first message line and action labels share one baseline.
          "flex flex-1 items-baseline gap-2.5 pt-3 pb-3.25 ps-3.75 pe-3 text-sm transition-opacity duration-200",
          // Behind the front toast in a collapsed stack only the card edge shows.
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
              className="line-clamp-2 text-sm leading-5 tracking-[-0.01em] break-words text-muted-foreground"
            >
              {description}
            </p>
          )}
        </div>
        {children && <div className="flex shrink-0 items-baseline gap-0.5">{children}</div>}
      </div>
      {duration !== undefined && (
        // Reduced motion hides the countdown: a frozen bar would misstate the time left.
        <div
          aria-hidden
          data-slot="toast-countdown"
          className="h-0.5 w-full bg-border motion-reduce:hidden"
        >
          <div
            className={cn(
              "h-full w-full origin-left animate-[toast-countdown_var(--toast-duration)_linear_forwards] bg-info",
              // Mirror Sonner's timer: it pauses while the stack is hovered or swiped, or the tab
              // is hidden.
              "in-data-[expanded=true]:[animation-play-state:paused] in-data-[swiping=true]:[animation-play-state:paused]",
              hidden && "[animation-play-state:paused]",
            )}
            style={{ "--toast-duration": `${duration}ms` } as CSSProperties}
          />
        </div>
      )}
    </div>
  );
}

// Sonner keeps its close timer running across in-place updates, but restarts it from the
// remaining time; a fresh key restarts the bar with it.
let renderCount = 0;

function notice(tone: ToastTone, message: string, options: NoticeOptions = {}): ToastId {
  const duration = options.duration ?? (tone === "error" ? ERROR_DURATION_MS : NOTICE_DURATION_MS);
  const key = ++renderCount;
  return toast.custom(
    (id) => (
      <ToastCard
        key={key}
        tone={tone}
        message={shorten(message)}
        description={options.description ? shorten(options.description) : undefined}
        duration={duration}
      >
        {options.action && (
          <ToastButton action={options.action} emphasis="quiet" onDone={() => toast.dismiss(id)} />
        )}
      </ToastCard>
    ),
    { id: options.id, duration },
  );
}

/**
 * Product toasts. Every toast is a card in the page's theme:
 * - notices (`success`, `error`, `warning`, `message`) leave on their own and show a countdown;
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
  prompt(message: string, options: PromptOptions): ToastId {
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
    );
  },

  dismiss: (id?: ToastId) => void toast.dismiss(id),
};

export type { NoticeOptions, PromptOptions, ToastAction, ToastId, ToastTone };
