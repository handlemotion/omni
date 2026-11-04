import { CheckIcon } from "@heroicons/react/24/outline";
import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { useEffect, useState } from "react";
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
 * A read-only value to copy, shaped like a 32px input: the kind on the left (hugging its label),
 * a divider, the value on the right. Clicking anywhere copies the value; a tooltip says so, then
 * confirms. For DNS records, API keys, addresses. The label hugs its text; to line up the dividers
 * of stacked fields, set `--copy-label-width` on their container.
 */
export function CopyField(props: { label: string; value: string; className?: string }) {
  const [hovered, setHovered] = useState(false);
  const [result, setResult] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), 1500);
    return () => clearTimeout(timer);
  }, [result]);

  // The tick shows on the click itself, before the clipboard answers; if it refuses, say so
  // rather than claim a copy that didn't happen.
  const copy = () => {
    setResult("copied");
    navigator.clipboard.writeText(props.value).catch(() => setResult("failed"));
  };

  return (
    <TooltipTrigger isOpen={hovered || result !== null} onOpenChange={setHovered} delay={300}>
      <Button
        aria-label={`Copy ${props.label.toLowerCase()}: ${props.value}`}
        onPress={copy}
        className={cn(WELL, "cursor-copy", props.className)}
      >
        <span className={LABEL}>{props.label}</span>
        <span className="flex min-w-0 flex-1 items-center px-2 text-foreground">
          <span className="truncate">{props.value}</span>
        </span>
      </Button>
      <Tooltip
        inverse
        arrow={false}
        offset={8}
        placement="end"
        className="flex items-center gap-1 px-1.5 py-1 text-xs"
      >
        {result === "copied" && <CheckIcon aria-hidden className="size-3" />}
        {result === "copied" ? "Copied" : result === "failed" ? "Copy failed" : "Click to copy"}
      </Tooltip>
    </TooltipTrigger>
  );
}

/**
 * A value that can't be shown again (only its hash is kept), in CopyField's shape so the rows keep
 * one rhythm and nothing moves when the new value replaces it. The whole field makes a new value;
 * the refresh mark at its end says so, and a tooltip (hover or focus) says what that costs.
 */
export function RenewField(props: {
  label: string;
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
        <span className={LABEL}>{props.label}</span>
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
      <Tooltip inverse arrow={false} offset={8} placement="end" className="px-1.5 py-1 text-xs">
        {props.tooltip}
      </Tooltip>
    </TooltipTrigger>
  );
}
