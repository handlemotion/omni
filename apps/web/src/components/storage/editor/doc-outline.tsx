import { cn } from "cn";
import { useEffect, useState, type RefObject } from "react";
import { IconH1, IconH2, IconH3, IconOutline } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { popupSurface } from "@/components/ui/popover";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";

const LEVEL_ICON = { H1: IconH1, H2: IconH2, H3: IconH3 } as const;
const INDENT = { H1: "", H2: "ps-5", H3: "ps-8" } as const;

interface Heading {
  id: string;
  text: string;
  level: keyof typeof LEVEL_ICON;
  element: Element;
}

function headingsOf(page: Element | null) {
  const found: Heading[] = [];
  for (const [i, element] of [...(page?.querySelectorAll("h1, h2, h3") ?? [])].entries()) {
    const text = element.textContent?.trim();
    if (text)
      found.push({ id: String(i), text, level: element.tagName as Heading["level"], element });
  }
  return found;
}

const go = (heading: Heading) =>
  heading.element.scrollIntoView({ block: "start", behavior: "smooth" });

/**
 * The doc's outline: its headings, read from the page when opened, each one scrolled to when
 * picked. `page` finds the doc's page in this panel.
 */
export function DocOutline(props: { page: () => Element | null }) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  return (
    <MenuTrigger onOpenChange={(open) => open && setHeadings(headingsOf(props.page()))}>
      <TooltipTrigger delay={400}>
        <Button intent="plain" size="sq-sm" aria-label="Outline">
          <IconOutline />
        </Button>
        <Tooltip>Outline</Tooltip>
      </TooltipTrigger>
      <Menu
        aria-label="Outline"
        placement="bottom start"
        popover={{ className: "min-w-64", offset: 4 }}
        renderEmptyState={() => (
          <div className="px-2.5 py-1.5 text-muted-foreground">No headings</div>
        )}
      >
        {headings.map((heading) => {
          const Icon = LEVEL_ICON[heading.level];
          return (
            <MenuItem
              key={heading.id}
              id={heading.id}
              textValue={heading.text}
              onAction={() => go(heading)}
            >
              <Icon data-slot="icon" />
              <MenuLabel>{heading.text}</MenuLabel>
            </MenuItem>
          );
        })}
      </Menu>
    </MenuTrigger>
  );
}

function useLiveHeadings(root: RefObject<HTMLElement | null>) {
  const [headings, setHeadings] = useState<Heading[]>([]);
  useEffect(() => {
    let frame = 0;
    let watched: Element | null = null;
    const read = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const page = root.current?.querySelector(".document-page") ?? null;
        if (page !== watched) {
          watched = page;
          if (page)
            pageObserver.observe(page, { childList: true, subtree: true, characterData: true });
        }
        setHeadings(headingsOf(page));
      });
    };
    const pageObserver = new MutationObserver(read);
    const rootObserver = new MutationObserver(read);
    if (root.current) rootObserver.observe(root.current, { childList: true, subtree: true });
    read();
    return () => {
      cancelAnimationFrame(frame);
      pageObserver.disconnect();
      rootObserver.disconnect();
    };
  }, [root]);
  return headings;
}

function useCurrentHeading(headings: Heading[]) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const first = headings[0];
    const scroller = first?.element.closest(".overflow-auto");
    if (!first || !scroller) return setCurrent(null);
    const update = () => {
      const top = scroller.getBoundingClientRect().top + 80;
      let at = first.id;
      for (const heading of headings) {
        if (heading.element.getBoundingClientRect().top <= top) at = heading.id;
      }
      setCurrent(at);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    return () => scroller.removeEventListener("scroll", update);
  }, [headings]);
  return current;
}

const LINE = { H1: "w-4", H2: "w-3", H3: "w-2" } as const;

/**
 * The outline of a full-screen doc, at its top left by the header: a stack of lines, one per
 * heading, the one being read darker. Under the pointer (or focus) it opens into the headings.
 */
export function FloatingOutline(props: { root: RefObject<HTMLElement | null> }) {
  const headings = useLiveHeadings(props.root);
  const current = useCurrentHeading(headings);
  const [open, setOpen] = useState(false);
  if (headings.length === 0) return null;
  return (
    <nav
      aria-label="Outline"
      className="absolute start-4 top-4 z-10"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(event) => !event.currentTarget.contains(event.relatedTarget) && setOpen(false)}
    >
      <div aria-hidden className="flex w-8 flex-col items-start gap-1.5 px-2 py-2">
        {headings.map((heading) => (
          <span
            key={heading.id}
            className={`h-0.5 rounded-full ${LINE[heading.level]} ${heading.id === current ? "bg-foreground" : "bg-border"}`}
          />
        ))}
      </div>
      {open && (
        <div className="absolute start-0 top-0">
          <ul className={cn(popupSurface, "flex max-h-[70vh] w-64 flex-col overflow-y-auto p-1")}>
            {headings.map((heading) => (
              <li key={heading.id} className={INDENT[heading.level]}>
                <Button
                  intent="plain"
                  size="sm"
                  aria-current={heading.id === current ? "location" : undefined}
                  className="w-full justify-start [--btn-foreground:var(--color-muted-foreground)] hover:[--btn-foreground:var(--color-foreground)] aria-[current]:[--btn-foreground:var(--color-foreground)]"
                  onPress={() => {
                    go(heading);
                    setOpen(false);
                  }}
                >
                  <span className="truncate">{heading.text}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
