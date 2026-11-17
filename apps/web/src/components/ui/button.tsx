import { Button as ButtonPrimitive } from "@ui-sdk/react/button";
import { tv, type VariantProps } from "tailwind-variants";
import { Children, isValidElement } from "react";
import { cx } from "@/lib/primitive";
import { Loader } from "./loader";

export const buttonStyles = tv({
  base: [
    "[--btn-border:var(--color-foreground)]/15 [--btn-icon-active:var(--btn-foreground)] [--btn-outline:var(--btn-bg)] [--btn-radius:calc(var(--radius-lg)-1px)]",
    "bg-(--btn-bg) text-(--btn-foreground) outline-(--btn-outline) hover:bg-(--btn-overlay) active:bg-(--btn-overlay) pressed:bg-(--btn-overlay)",
    "relative isolate inline-flex items-center justify-center border border-(--btn-border) hover:no-underline",
    "transition-[scale,background-color] duration-150 ease-out motion-safe:[&:active]:not-aria-[haspopup]:scale-97 disabled:[&:active]:scale-100 pending:[&:active]:scale-100",
    "focus:outline-0 focus-visible:outline focus-visible:outline-offset-2",
    "forced-colors:[--btn-icon:ButtonText] forced-colors:hover:[--btn-icon:ButtonText] *:[svg]:shrink-0 *:[svg]:self-center *:[svg]:text-(--btn-icon) hover:*:[svg]:text-(--btn-icon-active) active:*:[svg]:text-(--btn-icon-active) pressed:*:[svg]:text-(--btn-icon-active) focus-visible:*:[svg]:text-(--btn-icon-active)/80",
    "*:data-[slot=loader]:-mx-0.5 *:data-[slot=loader]:shrink-0 *:data-[slot=loader]:self-center *:data-[slot=loader]:text-(--btn-icon)",
    "pending:opacity-50 disabled:opacity-50 disabled:forced-colors:text-[GrayText]",
    "*:data-[slot=color-swatch]:-mx-0.5 *:data-[slot=color-swatch]:shrink-0 *:data-[slot=color-swatch]:self-center *:data-[slot=color-swatch]:[--size:--spacing(5)]",
  ],
  variants: {
    intent: {
      primary: [
        "shadow-(--shadow-button) [--btn-bg:var(--color-primary-button)] [--btn-border:color-mix(in_oklab,var(--color-primary-button)_85%,black)] [--btn-foreground:var(--color-primary-foreground)] [--btn-icon-active:var(--primary-foreground)] [--btn-icon:var(--primary-foreground)] [--btn-overlay:color-mix(in_oklab,var(--color-primary-foreground)_10%,var(--color-primary-button)_90%)]",
        "disabled:opacity-100 disabled:[--btn-bg:var(--color-secondary)] disabled:[--btn-border:color-mix(in_oklab,var(--color-secondary)_50%,var(--color-background))] disabled:[--btn-foreground:var(--color-muted-foreground)] disabled:[--btn-icon:var(--color-muted-foreground)] disabled:[--btn-icon-active:var(--color-muted-foreground)] disabled:[--btn-overlay:var(--color-secondary)]",
      ],
      secondary:
        "shadow-(--shadow-button) [--btn-border:color-mix(in_oklab,var(--color-secondary)_88%,black)] [--btn-bg:var(--color-secondary)] [--btn-foreground:var(--color-secondary-foreground)] [--btn-icon:var(--color-muted-foreground)] [--btn-outline:var(--color-secondary-foreground)] [--btn-overlay:color-mix(in_oklab,var(--color-secondary-foreground)_4%,var(--color-secondary))]",
      warning:
        "shadow-(--shadow-button) [--btn-border:color-mix(in_oklab,var(--color-warning)_80%,black)] [--btn-bg:var(--color-warning)] [--btn-foreground:var(--color-warning-foreground)] [--btn-icon:var(--color-warning-foreground)]/60 [--btn-overlay:color-mix(in_oklab,var(--color-white)_10%,var(--color-warning)_90%)]",
      danger:
        "[--btn-bg:var(--color-danger)] [--btn-border:color-mix(in_oklab,var(--color-danger)_80%,black)] [--btn-foreground:var(--color-danger-foreground)] [--btn-icon:var(--color-danger-foreground)] [--btn-overlay:color-mix(in_oklab,var(--color-white)_10%,var(--color-danger)_90%)] shadow-(--shadow-button)",
      success:
        "shadow-(--shadow-button) [--btn-border:color-mix(in_oklab,var(--color-success)_80%,black)] [--btn-bg:var(--color-success)] [--btn-foreground:var(--color-success-foreground)] [--btn-icon:color-mix(in_oklab,var(--color-success-foreground)_60%,var(--success)_40%)] [--btn-overlay:color-mix(in_oklab,var(--color-white)_10%,var(--color-success)_90%)]",
      outline:
        "shadow-(--shadow-button) border-border [--btn-bg:var(--color-background)] [--btn-foreground:var(--color-black)] [--btn-icon:var(--color-muted-foreground)] [--btn-outline:var(--color-ring)] [--btn-overlay:color-mix(in_oklab,var(--color-foreground)_4%,var(--color-background))]",
      ghost:
        "border-0 [--btn-bg:transparent] [--btn-foreground:var(--color-foreground)] [--btn-icon:var(--color-muted-foreground)] [--btn-outline:var(--color-ring)] [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)] aria-pressed:[--btn-bg:var(--color-accent)] aria-pressed:[--btn-icon:var(--color-foreground)]",
      plain:
        "border-0 [--btn-bg:transparent] [--btn-foreground:var(--color-foreground)] [--btn-icon:var(--color-muted-foreground)] [--btn-outline:var(--color-ring)] [--btn-overlay:transparent]",
    },
    size: {
      sm: ["h-7 gap-x-2 px-2.5 text-sm", "*:[svg]:size-3.5", "*:data-[slot=loader]:size-3.5"],
      md: ["h-8 gap-x-2.5 px-2.5 text-sm", "*:[svg]:size-4", "*:data-[slot=loader]:size-4"],
      lg: ["h-10 gap-x-2.5 px-3 text-sm", "*:[svg]:size-4.5", "*:data-[slot=loader]:size-4.5"],
      "sq-2xs": [
        "touch-target size-5 shrink-0",
        "*:[svg]:size-icon",
        "*:data-[slot=loader]:size-icon",
      ],
      "sq-xs": [
        "touch-target size-6.5 shrink-0",
        "*:[svg]:size-icon",
        "*:data-[slot=loader]:size-icon",
      ],
      "sq-sm": ["touch-target size-7 shrink-0", "*:[svg]:size-4", "*:data-[slot=loader]:size-4"],
      "sq-md": ["touch-target size-8 shrink-0", "*:[svg]:size-4", "*:data-[slot=loader]:size-4"],
      "sq-lg": [
        "touch-target size-10 shrink-0",
        "*:[svg]:size-4.5",
        "*:data-[slot=loader]:size-4.5",
      ],
      inset: "size-4.5 shrink-0 border-0",
      text: ["gap-x-1 p-0 text-xs", "*:[svg]:size-3"],
    },

    isCircle: {
      true: "rounded-full",
      false: "rounded-lg",
    },
  },
  compoundVariants: [
    { size: "inset", isCircle: false, class: "rounded-sm" },
    { size: "sq-2xs", isCircle: false, class: "rounded-sm" },
  ],
  defaultVariants: {
    intent: "primary",
    size: "md",
    isCircle: false,
  },
});

type ButtonPrimitiveProps = React.ComponentProps<typeof ButtonPrimitive>;

export interface ButtonProps
  extends
    Omit<ButtonPrimitiveProps, "onClick" | "disabled" | "children" | "className">,
    VariantProps<typeof buttonStyles> {
  ref?: React.Ref<HTMLButtonElement>;
  className?: string;
  children?: React.ReactNode;
  /** Runs on click, Enter or Space. */
  onPress?: () => unknown;
  isDisabled?: boolean;
  /**
   * An action in progress that the caller tracks (a mutation's `isPending`). The button stays
   * focusable, reports `aria-busy` and `aria-disabled`, and ignores presses until it settles.
   */
  isPending?: boolean;
}

export function Button({
  className,
  intent,
  size,
  isCircle,
  ref,
  children,
  onPress,
  isDisabled,
  isPending = false,
  ...props
}: ButtonProps & { onClick?: ButtonPrimitiveProps["onClick"] }) {
  const { onClick: forwardedClick, ...rest } = props;
  return (
    <ButtonPrimitive
      ref={ref}
      data-inset={size === "inset" || undefined}
      data-pending={isPending || undefined}
      aria-busy={isPending || undefined}
      disabled={isDisabled || isPending}
      focusableWhenDisabled={isPending || props.focusableWhenDisabled}
      {...rest}
      onClick={
        forwardedClick || onPress
          ? (...args: Parameters<NonNullable<ButtonPrimitiveProps["onClick"]>>) => {
              forwardedClick?.(...args);
              onPress?.();
            }
          : undefined
      }
      className={cx(buttonStyles({ intent, size, isCircle }), className)}
    >
      {isPending ? <Pending>{children}</Pending> : children}
    </ButtonPrimitive>
  );
}

/**
 * Loading: the button dims like a disabled one (`pending:opacity-50`). The first icon is swapped
 * for a spinner in the same place; a button with no icon shimmers its text instead.
 */
export function Pending({ children }: { children: React.ReactNode }) {
  const items = Children.toArray(children);
  const icon = items.findIndex((item) => isValidElement(item));
  if (icon === -1) return <span className="shimmer">{children}</span>;
  return items.map((item, i) =>
    i === icon ? <Loader key="loader" className="size-icon" /> : item,
  );
}
