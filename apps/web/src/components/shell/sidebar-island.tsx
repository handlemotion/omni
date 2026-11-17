import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarContent } from "@/components/ui/sidebar";

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
      className="fixed start-[17px] top-[51px] z-10 flex max-h-[calc(100svh-67px)] flex-col rounded-xl border border-sidebar-border bg-sidebar"
    >
      <SidebarContent className="flex-initial gap-1 p-1">
        {sections.map((section, index) => (
          <Fragment key={index}>
            {index > 0 && <Separator className="-mx-1 w-auto self-stretch bg-sidebar-border" />}
            <div className="flex flex-col gap-y-0.5">{section}</div>
          </Fragment>
        ))}
      </SidebarContent>
    </nav>
  );
}
