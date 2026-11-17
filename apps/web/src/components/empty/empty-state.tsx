// Every empty state, as dorks draws them (handlemotion/dorks, apps/web/src/components/EmptyState):
// a Hairline figure (`@lucasmarkes/hairline`), an isometric line drawing of an object holding
// nothing, then one or two lines of text and the actions. The figures answer the pointer, follow
// the theme on their own and rest still under reduced motion.
import { cn } from "cn";
import type { ReactNode } from "react";
import { Cabinet, Drawer, Exploded, Loupe, Padlock, Plug } from "@lucasmarkes/hairline/react";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/** The figures in use. Add one here before using a new one. */
const FIGURES = {
  cabinet: Cabinet,
  drawer: Drawer,
  exploded: Exploded,
  loupe: Loupe,
  padlock: Padlock,
  plug: Plug,
};

/**
 * Top to bottom: the figure (208px, 20px above the text), a title, a description only when it
 * helps, an identifier a person may quote (`meta`, meta-sized and selectable), then, 24px below,
 * the actions as small buttons.
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
    // A little above the true middle, where an empty page reads as centered.
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
        <EmptyContent className="flex-row justify-center gap-2">{props.children}</EmptyContent>
      )}
    </Empty>
  );
}
