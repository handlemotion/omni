// The closed sidebar's navigation (not on a phone): the module's places as icons on a small
// island at the window's start, fixed at the top, its top on the first group title of the page
// beside it ("Today"). Not a full-height rail: it is only as tall as its icons. Each icon is the
// sidebar's own row, collapsed (`SidebarItem`: a 28px square, its label as a tooltip, the current
// place on the accent fill); full-width lines divide the sections. No shadow: the border sets it
// on the canvas. Pages move over by the island's width (`var(--sidebar-island-width)`).
import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarContent } from "@/components/ui/sidebar";

/** The island's right edge, for the page beside it to start after: `var(--sidebar-island-width)`. */
const WIDTH_VAR = "--sidebar-island-width";

/** `sections`: each a group of `SidebarItem`s; a line runs between them. */
export function SidebarIsland({ sections }: { sections: ReactNode[] }) {
  const island = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    const element = island.current;
    if (!element) return;
    const root = document.documentElement.style;
    const observer = new ResizeObserver(() =>
      root.setProperty(WIDTH_VAR, `${element.getBoundingClientRect().right}px`),
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.removeProperty(WIDTH_VAR);
    };
  }, []);

  return (
    <nav
      ref={island}
      aria-label="Navigation"
      // 17px in, a touch nearer the window's edge than the page's first ink is to it (20px, the
      // rows' own inset). 51px down: its first button's top (past the 1px border and 4px padding)
      // on the top of the list's first date header's text, not the island's edge (measured).
      // Never past the window's foot (16px clear of it): a short window scrolls the icons inside.
      className="fixed start-[17px] top-[51px] z-10 flex max-h-[calc(100svh-67px)] flex-col rounded-xl border border-sidebar-border bg-sidebar"
    >
      {/* The sidebar's list, for its one hover highlight; 4px round the 28px icons. */}
      <SidebarContent className="flex-initial gap-1 p-1">
        {sections.map((section, index) => (
          <Fragment key={index}>
            {/* Edge to edge, through the island's 4px padding. */}
            {index > 0 && <Separator className="-mx-1 w-auto self-stretch bg-sidebar-border" />}
            <div className="flex flex-col gap-y-0.5">{section}</div>
          </Fragment>
        ))}
      </SidebarContent>
    </nav>
  );
}
