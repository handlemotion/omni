import { cn } from "cn";
import type { ReactNode } from "react";
import { Cabinet, Dish, Drawer, Exploded, Loupe, Padlock, Plug } from "@lucasmarkes/hairline/react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

const FIGURES = {
  cabinet: Cabinet,
  dish: Dish,
  drawer: Drawer,
  exploded: Exploded,
  loupe: Loupe,
  padlock: Padlock,
  plug: Plug,
};

/**
 * Top to bottom: the figure (208px, 20px above the text), a title, a description only when it
 * helps, an identifier a person may quote (`meta`, meta-sized and selectable), then, 24px below,
 * the actions as small buttons, wrapping onto a second row when they outgrow the column.
 */
export function EmptyState(props: {
  figure: keyof typeof FIGURES;
  title: string;
  description?: string;
  meta?: string;
  children?: ReactNode;
  /** Spacing for a smaller frame than a page (the command menu's list). */
  className?: string;
}) {
  const Figure = FIGURES[props.figure];
  return (
    <Empty className={cn("gap-6 p-8 pb-24", props.className)}>
      <EmptyHeader className="gap-1">
        <EmptyMedia className="mb-5 w-52 [&_svg]:pointer-events-auto">
          <Figure aria-hidden className="w-full" />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.description && <EmptyDescription>{props.description}</EmptyDescription>}
        {props.meta && (
          <EmptyDescription className="text-xs tabular-nums select-text">
            {props.meta}
          </EmptyDescription>
        )}
      </EmptyHeader>
      {props.children && (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {props.children}
        </EmptyContent>
      )}
    </Empty>
  );
}
