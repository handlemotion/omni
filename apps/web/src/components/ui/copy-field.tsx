import { CheckIcon } from "@heroicons/react/24/outline";
import { useEffect, useState } from "react";
import { Button } from "react-aria-components/Button";
import { cn } from "cn";
import { Tooltip, TooltipTrigger } from "./tooltip";

/**
 * A read-only value to copy, shaped like a 32px input: the kind on the left (hugging its label),
 * a divider, the value on the right. Clicking anywhere copies the value; a tooltip says so, then
 * confirms. For DNS records, API keys, addresses. The label hugs its text; to line up the dividers
 * of stacked fields, set `--copy-label-width` on their container.
 */
export function CopyField(props: { label: string; value: string; className?: string }) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <TooltipTrigger isOpen={hovered || copied} onOpenChange={setHovered} delay={300}>
      <Button
        aria-label={`Copy ${props.label.toLowerCase()}: ${props.value}`}
        onPress={() => void navigator.clipboard.writeText(props.value).then(() => setCopied(true))}
        className={cn(
          "flex h-8 w-full min-w-0 cursor-copy items-stretch overflow-hidden rounded-lg border border-input bg-background text-start text-sm outline-hidden",
          "hover:border-muted-foreground/30 focus-visible:border-ring/70",
          props.className,
        )}
      >
        <span className="flex min-w-(--copy-label-width,0) shrink-0 items-center border-e border-input px-2 text-muted-foreground">
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
        {copied && <CheckIcon aria-hidden className="size-3" />}
        {copied ? "Copied" : "Click to copy"}
      </Tooltip>
    </TooltipTrigger>
  );
}
