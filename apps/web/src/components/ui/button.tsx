import {
  Button as ButtonPrimitive,
  type ButtonProps as ButtonPrimitiveProps,
} from "react-aria-components/Button";
import { tv, type VariantProps } from "tailwind-variants";
import { Children, isValidElement } from "react";
import { cx } from "@/lib/primitive";
import { Loader } from "./loader";

export const buttonStyles = tv({
  base: [
    "[--btn-border:var(--color-foreground)]/15 [--btn-icon-active:var(--btn-foreground)] [--btn-outline:var(--btn-bg)] [--btn-radius:calc(var(--radius-lg)-1px)] [--btn-ring:var(--btn-bg)]/20",
    "bg-(--btn-bg) text-(--btn-foreground) outline-(--btn-outline) ring-(--btn-ring) hover:bg-(--btn-overlay) pressed:bg-(--btn-overlay)",
    "relative isolate inline-flex items-center justify-center border border-(--btn-border) hover:no-underline",
    "focus:outline-0 focus-visible:outline focus-visible:outline-offset-2 focus-visible:ring-2 focus-visible:ring-offset-3 focus-visible:ring-offset-background",
    "forced-colors:[--btn-icon:ButtonText] forced-colors:hover:[--btn-icon:ButtonText] *:[svg]:shrink-0 *:[svg]:self-center *:[svg]:text-(--btn-icon) hover:*:[svg]:text-(--btn-icon-active) pressed:*:[svg]:text-(--btn-icon-active) focus-visible:*:[svg]:text-(--btn-icon-active)/80",
    "*:data-[slot=loader]:-mx-0.5 *:data-[slot=loader]:shrink-0 *:data-[slot=loader]:self-center *:data-[slot=loader]:text-(--btn-icon)",
    "pending:opacity-50 disabled:opacity-50 disabled:forced-colors:text-[GrayText]",
    "*:data-[slot=color-swatch]:-mx-0.5 *:data-[slot=color-swatch]:shrink-0 *:data-[slot=color-swatch]:self-center *:data-[slot=color-swatch]:[--size:--spacing(5)]",
  ],
  variants: {
    intent: {
      primary:
        "[--btn-bg:var(--color-primary)] [--btn-border:var(--color-primary-foreground)] [--btn-foreground:var(--color-primary-foreground)] [--btn-icon-active:var(--primary-foreground)]/80 [--btn-icon:var(--primary-foreground)]/60 [--btn-overlay:color-mix(in_oklab,var(--color-primary-foreground)_10%,var(--color-primary)_90%)]",
      secondary:
        "[--btn-bg:var(--color-secondary)] [--btn-foreground:var(--color-secondary-foreground)] [--btn-icon:var(--color-muted-foreground)] [--btn-outline:var(--color-secondary-foreground)] [--btn-overlay:color-mix(in_oklab,var(--color-secondary-foreground)_10%,var(--color-secondary)_90%)] [--btn-ring:var(--color-muted-foreground)]/20",
      warning:
        "[--btn-bg:var(--color-warning)] [--btn-foreground:var(--color-warning-foreground)] [--btn-icon:var(--color-warning-foreground)]/60 [--btn-overlay:color-mix(in_oklab,var(--color-white)_10%,var(--color-warning)_90%)]",
      // Filled red with a 1px darker edge and a faint top highlight (onboarding reference).
      danger:
        "[--btn-bg:var(--color-danger)] [--btn-border:color-mix(in_oklab,var(--color-danger)_80%,black)] [--btn-foreground:var(--color-danger-foreground)] [--btn-icon:var(--color-danger-foreground)] [--btn-overlay:color-mix(in_oklab,var(--color-white)_10%,var(--color-danger)_90%)] shadow-[inset_0_1px_0_rgb(255_255_255/0.15),0_1px_2px_rgb(0_0_0/0.06)]",
      success:
        "[--btn-bg:var(--color-success)] [--btn-foreground:var(--color-success-foreground)] [--btn-icon:color-mix(in_oklab,var(--color-success-foreground)_60%,var(--success)_40%)] [--btn-overlay:color-mix(in_oklab,var(--color-white)_10%,var(--color-success)_90%)]",
      outline:
        "border-border [--btn-bg:var(--color-background)] [--btn-foreground:var(--color-black)] [--btn-icon:var(--color-muted-foreground)] [--btn-outline:var(--color-ring)] [--btn-overlay:var(--color-secondary)] [--btn-ring:var(--color-ring)]/20",
      plain:
        "border-0 [--btn-bg:transparent] [--btn-foreground:var(--color-foreground)] [--btn-icon:var(--color-muted-foreground)] [--btn-outline:var(--color-ring)] [--btn-overlay:transparent] [--btn-ring:var(--color-ring)]/20",
    },
    size: {
      xs: ["h-7 gap-x-2.5 px-2 text-sm", "*:[svg]:size-icon", "*:data-[slot=loader]:size-icon"],
      sm: [
        "min-h-9 gap-x-1.5 px-3 py-[calc(--spacing(2)-1px)] sm:min-h-8 sm:px-[calc(--spacing(3)-1px)] sm:py-[calc(--spacing(1.5)-1px)] sm:text-sm/5",
        "*:[svg]:size-4.5 sm:*:[svg]:size-4",
        "*:data-[slot=loader]:size-4.5 sm:*:data-[slot=loader]:size-4",
      ],
      md: ["h-8 gap-x-2.5 px-2 text-sm", "*:[svg]:size-icon", "*:data-[slot=loader]:size-icon"],
      lg: ["h-9 gap-x-2.5 px-2.5 text-sm", "*:[svg]:size-icon", "*:data-[slot=loader]:size-icon"],
      "sq-xs": [
        "touch-target size-6.5 shrink-0",
        "*:[svg]:size-icon",
        "*:data-[slot=loader]:size-icon",
      ],
      "sq-sm": [
        "touch-target size-10 shrink-0 sm:size-8",
        "*:[svg]:size-4.5 sm:*:[svg]:size-4",
        "*:data-[slot=loader]:size-4.5 sm:*:data-[slot=loader]:size-4",
      ],
      "sq-md": [
        "touch-target size-11 shrink-0 sm:size-9",
        "*:[svg]:size-5 sm:*:[svg]:size-4.5",
        "*:data-[slot=loader]:size-5 sm:*:data-[slot=loader]:size-4.5",
      ],
      "sq-lg": [
        "touch-target size-12 shrink-0 sm:size-10",
        "*:[svg]:size-6 sm:*:[svg]:size-5",
        "*:data-[slot=loader]:size-6 sm:*:data-[slot=loader]:size-5",
      ],
      // An action tucked inside a field, e.g. the submit arrow at the end of an input.
      inset: "size-4.5 shrink-0 border-0",
    },

    isCircle: {
      true: "rounded-full",
      false: "rounded-lg",
    },
  },
  compoundVariants: [{ size: "inset", isCircle: false, class: "rounded-sm" }],
  defaultVariants: {
    intent: "primary",
    size: "md",
    isCircle: false,
  },
});

export interface ButtonProps extends ButtonPrimitiveProps, VariantProps<typeof buttonStyles> {
  ref?: React.Ref<HTMLButtonElement>;
}

export function Button({
  className,
  intent,
  size,
  isCircle,
  ref,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      ref={ref}
      data-inset={size === "inset" || undefined}
      {...props}
      className={cx(buttonStyles({ intent, size, isCircle }), className)}
    >
      {(values) => {
        const content = typeof children === "function" ? children(values) : children;
        return values.isPending ? <Pending>{content}</Pending> : content;
      }}
    </ButtonPrimitive>
  );
}

/**
 * Loading: the button dims like a disabled one (`pending:opacity-50`). The first icon is swapped
 * for a spinner in the same place; a button with no icon shimmers its text instead.
 */
function Pending({ children }: { children: React.ReactNode }) {
  const items = Children.toArray(children);
  const icon = items.findIndex((item) => isValidElement(item));
  if (icon === -1) return <span className="shimmer">{children}</span>;
  return items.map((item, i) =>
    i === icon ? <Loader key="loader" className="size-icon" /> : item,
  );
}
