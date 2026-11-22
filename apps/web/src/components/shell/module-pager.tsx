import { useRouter } from "@tanstack/react-router";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useCurrentModule, useModules, useOpenModule, type ModuleId } from "./module-switcher";

const SETTLE_MS = 120;
const GLIDE_MS = 300;
const ON_PAGE = 0.01;

const glideMotion = () =>
  (window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "instant"
    : "smooth") satisfies ScrollBehavior;

interface Pages {
  shown: () => number;
  settledOn: (page: number) => void;
}

// WARNING: a smooth scrollTo is dropped when the pages re-render mid-glide; glide by hand.
function drivePages(el: HTMLElement, root: HTMLElement, pages: Pages) {
  let gliding = 0;
  let timer = 0;
  const publish = () => {
    if (el.clientWidth > 0)
      root.style.setProperty("--module-at", `${el.scrollLeft / el.clientWidth}`);
  };
  const stopGliding = () => {
    if (!gliding) return;
    cancelAnimationFrame(gliding);
    gliding = 0;
  };
  const glide = (page: number, behavior: ScrollBehavior) => {
    stopGliding();
    const from = el.scrollLeft;
    const to = () => page * el.clientWidth;
    if (behavior === "instant" || Math.abs(from - to()) < 1) {
      el.scrollLeft = to();
      return publish();
    }
    const start = performance.now();
    const frame = (now: number) => {
      const t = Math.min(1, (now - start) / GLIDE_MS);
      el.scrollLeft = from + (to() - from) * (1 - (1 - t) ** 3);
      if (t < 1) gliding = requestAnimationFrame(frame);
      else stopGliding();
    };
    gliding = requestAnimationFrame(frame);
  };
  const settle = () => {
    if (el.clientWidth === 0 || gliding) return;
    const at = el.scrollLeft / el.clientWidth;
    const page = Math.round(at);
    if (Math.abs(at - page) <= ON_PAGE && page !== pages.shown()) pages.settledOn(page);
  };
  const onScroll = () => {
    publish();
    window.clearTimeout(timer);
    timer = window.setTimeout(settle, SETTLE_MS);
  };
  const resize = new ResizeObserver(() => {
    if (!gliding) glide(pages.shown(), "instant");
  });

  glide(pages.shown(), "instant");
  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("scrollend", settle);
  resize.observe(el);
  return {
    glide,
    stop: () => {
      window.clearTimeout(timer);
      stopGliding();
      resize.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("scrollend", settle);
    },
  };
}

/**
 * The sidebar's nav, one page per module side by side. Opening a module (the rail, the phone's
 * switcher, `g f`) glides the pages there; they don't scroll under a swipe. The pages' position
 * is `--module-at` on the sidebar (0 on the first page, 1 on the second, fractions between), so
 * the phone switcher's pill moves with them. Pages other than the shown one are inert and hidden
 * from assistive tech.
 */
export function ModulePager({ pages }: { pages: Record<ModuleId, ReactNode> }) {
  const modules = useModules();
  const current = useCurrentModule();
  const index = Math.max(
    0,
    modules.findIndex((module) => module.id === current),
  );
  const open = useOpenModule();
  const router = useRouter();
  const pager = useRef<HTMLDivElement>(null);
  const glideTo = useRef<ReturnType<typeof drivePages>["glide"]>(null);
  const opening = useRef<number | null>(null);
  const latest = useRef({ index, modules, open });
  latest.current = { index, modules, open };

  useLayoutEffect(() => {
    const el = pager.current;
    const root = el?.closest<HTMLElement>('[data-slot="sidebar"]');
    if (!el || !root) return;
    const shown = () => latest.current.index;
    const driver = drivePages(el, root, {
      shown,
      settledOn: (page) => {
        const target = latest.current.modules[page];
        if (!target) return;
        if (router.history._getBlockers().length > 0) {
          driver.glide(shown(), glideMotion());
          void latest.current.open(target.id);
          return;
        }
        opening.current = page;
        void latest.current.open(target.id).finally(() =>
          requestAnimationFrame(() => {
            if (opening.current !== page) return;
            opening.current = null;
            if (shown() !== page) driver.glide(shown(), glideMotion());
          }),
        );
      },
    });
    glideTo.current = driver.glide;
    return () => {
      driver.stop();
      glideTo.current = null;
    };
  }, [router]);

  useLayoutEffect(() => {
    if (opening.current === index) opening.current = null;
    if (opening.current === null) glideTo.current?.(index, glideMotion());
  }, [index]);

  return (
    <div ref={pager} data-slot="module-pager" className="-mx-3 flex min-h-0 flex-1 overflow-hidden">
      {modules.map((module, at) => (
        <div
          key={module.id}
          data-module-page={module.id}
          inert={at !== index}
          aria-hidden={at !== index || undefined}
          className="flex w-full flex-none flex-col gap-3 overflow-y-auto px-3 *:shrink-0"
        >
          {pages[module.id]}
        </div>
      ))}
    </div>
  );
}
