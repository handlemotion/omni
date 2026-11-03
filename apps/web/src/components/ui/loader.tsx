import { ProgressBar } from "react-aria-components/ProgressBar";
import { cn } from "cn";

// One arc that spins: a ring with a gap, no track. Same stroke weight as the Figma icons.
function Ring({ className, ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={cn("size-4", className)}
      {...props}
      viewBox="0 0 15 15"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="7.5"
        cy="7.5"
        r="6"
        stroke="currentColor"
        strokeWidth="0.9375"
        strokeLinecap="round"
        strokeDasharray="28 38"
      />
    </svg>
  );
}

const LOADERS = {
  ring: Ring,
};

const DEFAULT_SPINNER = "ring";

export interface LoaderProps extends Omit<
  React.ComponentPropsWithoutRef<"svg">,
  "display" | "opacity" | "intent"
> {
  variant?: keyof typeof LOADERS;
  percentage?: number;
  isIndeterminate?: boolean;
  formatOptions?: Intl.NumberFormatOptions;
  ref?: React.RefObject<SVGSVGElement>;
  "data-slot"?: string;
}

export function Loader({ isIndeterminate = true, ref, ...props }: LoaderProps) {
  const { className, variant = DEFAULT_SPINNER, ...spinnerProps } = props;
  const LoaderPrimitive = LOADERS[variant in LOADERS ? variant : DEFAULT_SPINNER];

  return (
    <ProgressBar
      data-slot={props["data-slot"] ?? "loader"}
      aria-label={props["aria-label"] ?? "Pending..."}
      formatOptions={props.formatOptions}
      isIndeterminate={isIndeterminate}
    >
      <LoaderPrimitive
        role="presentation"
        className={cn("size-4", "animate-spin", className)}
        ref={ref}
        {...spinnerProps}
      />
    </ProgressBar>
  );
}
