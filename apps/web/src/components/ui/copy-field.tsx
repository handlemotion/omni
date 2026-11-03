import { CheckIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Button } from "react-aria-components/Button";
import { cn } from "cn";
import { Tooltip, TooltipTrigger } from "./tooltip";

/**
 * A read-only value to copy, shaped like a 32px input (a well): the kind on the left (hugging its
 * label), a hairline divider, the value on the right. Clicking anywhere copies the value; a
 * tooltip says so, then confirms. For DNS records, API keys, addresses. The label hugs its text;
 * to line up the dividers of stacked fields, set `--copy-label-width` on their container.
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
        className={cn(
          "flex h-8 w-full min-w-0 cursor-copy items-stretch overflow-hidden rounded-lg bg-well text-start text-sm outline-hidden",
          "transition-colors duration-150 ease-out hover:bg-well-focus focus-visible:ring-2 focus-visible:ring-focus-ring",
          props.className,
        )}
      >
        <span className="flex min-w-(--copy-label-width,0) shrink-0 items-center border-e-(length:--hairline) border-line px-2 text-muted-foreground">
          {props.label}
        </span>
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
