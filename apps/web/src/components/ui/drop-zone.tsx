import { composeRenderProps } from "react-aria-components/composeRenderProps";
import { DropZone as DropPrimitiveZone, type DropZoneProps } from "react-aria-components/DropZone";
import { cn } from "cn";

export function DropZone({
  className,
  bare = false,
  ...props
}: DropZoneProps & {
  /**
   * No frame (dashed border, padding, height cap): a whole area takes the drop, a page's content
   * for one, and shows it by its tint alone.
   */
  bare?: boolean;
}) {
  return (
    <DropPrimitiveZone
      className={composeRenderProps(className, (className, { isDropTarget }) =>
        cn(
          "group/drop-zone relative z-10 flex max-h-56 items-center justify-center overflow-hidden rounded-lg border border-dashed p-6",
          isDropTarget && "border-primary border-solid bg-primary/10",
          bare && "block max-h-none rounded-none border-0 p-0",
          className,
        ),
      )}
      {...props}
    />
  );
}
