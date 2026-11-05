import { CheckIcon } from "@heroicons/react/24/outline";
import { ArrowPathIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
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
/** Green well: the value is in place already (a DNS record the domain serves). */
const DONE = "bg-success-subtle hover:bg-success-subtle text-success-subtle-foreground";

export function CopyField(props: {
  label: string;
  value: string;
  /** In place already: the well turns green. Still copies. */
  done?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<"copied" | "failed" | null>(null);

  // The tooltip is open only while hovered or focused, like any other: "Copied" shows there and
  // never holds a field's tooltip open after the pointer leaves, so moving on to the next field
  // can't leave two up. Leaving resets it to "Click to copy".
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setResult(null);
  };

  // The tick shows on the click itself, before the clipboard answers; if it refuses, say so
  // rather than claim a copy that didn't happen.
  const copy = () => {
    setResult("copied");
    setOpen(true);
    navigator.clipboard.writeText(props.value).catch(() => setResult("failed"));
  };

  return (
    <TooltipTrigger
      isOpen={open}
      onOpenChange={onOpenChange}
      delay={300}
      shouldCloseOnPress={false}
    >
      <Button
        aria-label={`Copy ${props.label.toLowerCase()}: ${props.value}`}
        onPress={copy}
        className={cn(WELL, "cursor-copy", props.done && DONE, props.className)}
      >
        <span className={LABEL}>{props.label}</span>
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center px-2",
            props.done ? "text-success-subtle-foreground" : "text-foreground",
          )}
        >
          <span className="truncate">{props.value}</span>
        </span>
      </Button>
      <Tooltip arrow={false} placement="end" className="flex items-center gap-1">
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
      <Tooltip arrow={false} placement="end">
        {props.tooltip}
      </Tooltip>
    </TooltipTrigger>
  );
}

/**
 * CopyField's shape, in green, for a value that is in place but can't be shown (only its hash is
 * kept), said in words. Nothing to press: making a new one would replace a value that works.
 */
export function StaticField(props: { label: string; text: string; className?: string }) {
  return (
    <div className={cn(WELL[0], DONE, props.className)}>
      <span className={LABEL}>{props.label}</span>
      <span className="flex min-w-0 flex-1 items-center px-2">
        <span className="truncate">{props.text}</span>
      </span>
    </div>
  );
}
