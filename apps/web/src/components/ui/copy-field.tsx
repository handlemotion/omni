import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { Button } from "react-aria-components/Button";
import { cn } from "cn";
import { Loader } from "./loader";
import { Tooltip, TooltipTrigger } from "./tooltip";

/** A well: sunk into its surface, no border; hover deepens it one step. */
const WELL = [
  "flex h-8 w-full min-w-0 items-stretch overflow-hidden rounded-lg bg-well text-start text-sm outline-hidden",
  "transition-colors duration-150 ease-out hover:bg-well-hover focus-visible:ring-1 focus-visible:ring-ring",
];
const LABEL =
  "flex min-w-(--copy-label-width,0) shrink-0 items-center border-e-[0.5px] border-hairline-line px-2 text-muted-foreground";

/**
 * A value that can't be shown again (only its hash is kept), in a 32px well so the rows keep
 * one rhythm and nothing moves when the new value replaces it. The whole field makes a new value;
 * the refresh mark at its end says so, and a tooltip (hover or focus) says what that costs.
 */
export function RenewField(props: {
  /** The field's own label; left out where the row already names it (a records table). */
  label?: string;
  /** What the field says in place of the value, e.g. "Hidden". */
  placeholder: string;
  /** The action and its consequence, e.g. "Show a new value. It replaces the old one." */
  tooltip: string;
  isPending?: boolean;
  onPress: () => void;
  className?: string;
}) {
  return (
    <TooltipTrigger delay={300}>
      <Button
        aria-label={props.tooltip}
        isPending={props.isPending}
        onPress={props.onPress}
        className={cn(WELL, "group/renew cursor-pointer", props.className)}
      >
        {props.label && <span className={LABEL}>{props.label}</span>}
        <span className="flex min-w-0 flex-1 items-center justify-between gap-2 ps-2 pe-1.5 text-muted-foreground">
          <span className="truncate">{props.placeholder}</span>
          {props.isPending ? (
            <Loader className="size-icon" />
          ) : (
            <ArrowPathIcon
              aria-hidden
              className="size-3.5 shrink-0 transition-colors group-hover/renew:text-foreground group-focus-visible/renew:text-foreground"
            />
          )}
        </span>
      </Button>
      <Tooltip arrow={false} placement="end">
        {props.tooltip}
      </Tooltip>
    </TooltipTrigger>
  );
}
