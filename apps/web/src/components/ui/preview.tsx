import { PreviewTrigger as PreviewTriggerPrimitive } from "react-aria-components/PreviewTrigger";
import {
  AriaPopover as Popover,
  type AriaPopoverProps as PopoverProps,
} from "@/components/ui/aria-popover";
import { cx } from "@/lib/primitive";

export const PreviewTrigger = PreviewTriggerPrimitive;
export function Preview({ className, ...props }: PopoverProps) {
  return <Popover className={cx("p-4 max-w-xs", className)} {...props} />;
}
