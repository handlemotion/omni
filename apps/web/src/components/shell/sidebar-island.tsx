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
      // Its icons centred under the title bar's sidebar toggle, on the nav icons' 23.5px axis (the
      // red traffic light's, on a Mac): 4.5px in, then the 1px border, 4px padding and half a 28px
      // icon. 56px down: its top edge on the top of the list's first date header's text (the 48px
      // title row, then that header; measured).
      className="fixed start-[4.5px] top-14 z-10 rounded-xl border border-sidebar-border bg-sidebar"
    >
      {/* The sidebar's list, for its one hover highlight; 4px round the 28px icons. */}
      <SidebarContent className="flex-none gap-1 overflow-visible p-1">
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
