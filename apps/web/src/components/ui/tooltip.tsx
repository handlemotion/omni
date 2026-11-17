import {
  createTooltipController,
  Tooltip as TooltipRoot,
  TooltipArrow,
  TooltipContent,
  TooltipTrigger as TooltipTriggerPrimitive,
} from "@ui-sdk/react/tooltip";
import {
  Children,
  isValidElement,
  useId,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { twJoin } from "cn";
import type { VariantProps } from "tailwind-variants";
import { tv } from "tailwind-variants";
import { toSideAlign, type Placement } from "./placement";

const tooltipStyles = tv({
  base: [
    "group w-fit max-w-xs origin-(--transform-origin) rounded-md px-2 py-1.5 text-xs text-balance *:[strong]:font-medium",
    "transition-[opacity,scale] duration-150 ease-out data-ending-style:duration-100 motion-reduce:transition-none",
    "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-instant:transition-none",
  ],
  variants: {
    inverse: {
      true: ["bg-tooltip text-background", "**:[.text-muted-foreground]:text-background/60"],
      false: "border border-border bg-overlay text-overlay-foreground",
    },
  },
  defaultVariants: {
    inverse: true,
  },
});

const sharedTooltip = createTooltipController<string>();
const entries = new Map<string, TooltipProps>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const showable = (id: string | undefined) => {
  const entry = id ? entries.get(id) : undefined;
  return Boolean(entry && !entry.hidden);
};

const SHARED_DELAY = 400;
const SHARED_CLOSE_DELAY = 120;

function slide(el: HTMLElement | null) {
  if (!el) return;
  let last: { x: number; y: number } | null = null;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const observer = new MutationObserver(() => {
    if (!el.hasAttribute("data-open")) {
      last = null;
      return;
    }
    const now = { x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 };
    const from = last;
    last = now;
    if (!from || reduce.matches) return;
    const [tx = 0, ty = 0] = getComputedStyle(el)
      .translate.split(" ")
      .map((v) => parseFloat(v) || 0);
    const dx = from.x + tx - now.x;
    const dy = from.y + ty - now.y;
    for (const running of el.getAnimations()) if (running.id === "slide") running.cancel();
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    const animation = el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], {
      duration: 180,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
    animation.id = "slide";
  });
  observer.observe(el, { attributes: true, attributeFilter: ["style", "data-open"] });
  return () => observer.disconnect();
}

/** The one shared tooltip. Mount it once, at the root. */
export function SharedTooltip() {
  const [id, setId] = useState<string>();
  const props = useSyncExternalStore(subscribe, () => (id ? entries.get(id) : undefined));
  return (
    <TooltipRoot
      controller={sharedTooltip}
      delay={SHARED_DELAY}
      closeDelay={SHARED_CLOSE_DELAY}
      onOpenChange={(open, details) => {
        if (open && !showable(sharedTooltip.getPayload())) details.cancel();
      }}
      onPayloadChange={(next, details) => {
        if (showable(next as string)) return setId(next as string);
        details.cancel();
        sharedTooltip.close();
      }}
    >
      <TooltipBody {...props} ref={slide} />
    </TooltipRoot>
  );
}

export interface TooltipTriggerProps {
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Milliseconds the pointer rests on the trigger before the tooltip opens. */
  delay?: number;
  closeDelay?: number;
  isDisabled?: boolean;
  /** The trigger element first, then its `<Tooltip>`. */
  children: ReactNode;
  /** Props another component's trigger part passes on (a menu's), for the trigger element. */
  [prop: string]: unknown;
}

/**
 * Keeps React Aria's shape (`<TooltipTrigger><Button/><Tooltip/></TooltipTrigger>`) on UI SDK's
 * parts: the first child becomes the trigger through `render`, so it must forward its props and
 * ref to its DOM element. A `<Tooltip hidden>` turns the tooltip off but keeps the trigger. Inside
 * a `MenuTrigger` or `PopoverTrigger`, the props and ref that trigger passes reach the element too.
 *
 * Hover tooltips join the shared one (`SharedTooltip`), at its delay. A controlled tooltip, or one
 * that opens at once (`delay={0}`: the collapsed sidebar's labels), keeps a tooltip of its own.
 */
export function TooltipTrigger({
  delay,
  closeDelay,
  isDisabled,
  isOpen,
  onOpenChange,
  children,
  ...forwarded
}: TooltipTriggerProps) {
  const [trigger, ...rest] = Children.toArray(children);
  const tooltip = rest.find(
    (child): child is ReactElement<TooltipProps> => isValidElement(child) && child.type === Tooltip,
  );
  const own = isOpen !== undefined || onOpenChange !== undefined || delay === 0;
  const id = useId();
  const entry =
    own || !tooltip ? undefined : { ...tooltip.props, hidden: isDisabled || tooltip.props.hidden };

  useLayoutEffect(() => {
    if (!entry) return;
    entries.set(id, entry);
    notify();
  });
  useLayoutEffect(
    () => () => {
      if (!entries.delete(id)) return;
      if (sharedTooltip.getPayload() === id && sharedTooltip.isOpen()) sharedTooltip.close();
      notify();
    },
    [id],
  );

  const element = trigger as ReactElement<Record<string, unknown>>;
  if (!own) {
    return (
      <TooltipTriggerPrimitive
        {...forwarded}
        controller={sharedTooltip}
        payload={id}
        render={element}
      />
    );
  }
  return (
    <TooltipRoot
      open={isOpen}
      onOpenChange={onOpenChange && ((open) => onOpenChange(open))}
      delay={delay}
      closeDelay={closeDelay}
      disabled={isDisabled || Boolean(tooltip?.props.hidden)}
    >
      <TooltipTriggerPrimitive {...forwarded} render={element} />
      {rest}
    </TooltipRoot>
  );
}

export interface TooltipProps extends VariantProps<typeof tooltipStyles> {
  arrow?: boolean;
  placement?: Placement;
  /** Gap to the trigger, in pixels. */
  offset?: number;
  className?: string;
  hidden?: boolean;
  children?: ReactNode;
}

/** Marks a trigger's tooltip; `TooltipTrigger` decides where it renders. */
export function Tooltip(props: TooltipProps) {
  if (props.hidden) return null;
  return <TooltipBody {...props} />;
}

function TooltipBody({
  offset = 6,
  arrow = false,
  inverse,
  placement = "top",
  className,
  children,
  ref,
}: TooltipProps & { ref?: React.Ref<HTMLDivElement> }) {
  return (
    <TooltipContent
      ref={ref}
      {...toSideAlign(placement)}
      sideOffset={offset}
      className={tooltipStyles({ inverse, className })}
    >
      {arrow && (
        <TooltipArrow className="group-data-[side=top]:top-full group-data-[side=bottom]:bottom-full group-data-[side=left]:left-full group-data-[side=right]:right-full">
          <svg
            width={10}
            height={5}
            viewBox="0 0 10 5"
            aria-hidden
            className={twJoin(
              "block group-data-[side=bottom]:rotate-180 group-data-[side=left]:-rotate-90 group-data-[side=right]:rotate-90 forced-colors:fill-[Canvas] forced-colors:stroke-[ButtonBorder]",
              inverse === false ? "fill-overlay stroke-border" : "fill-tooltip stroke-transparent",
            )}
          >
            <path d="M0 0 L5 5 L10 0" />
          </svg>
        </TooltipArrow>
      )}
      {children}
    </TooltipContent>
  );
}
