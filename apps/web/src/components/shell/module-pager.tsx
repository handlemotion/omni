import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useCurrentModule, useModules, type ModuleId } from "./module-switcher";

const GLIDE_MS = 300;

const glideMotion = () =>
  (window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "instant"
    : "smooth") satisfies ScrollBehavior;

// WARNING: a smooth scrollTo is dropped when the pages re-render mid-glide; glide by hand.
function drivePages(el: HTMLElement, root: HTMLElement, shown: () => number) {
  let gliding = 0;
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
  const onScroll = () => {
    if (gliding || el.clientWidth === 0) return publish();
    if (Math.abs(el.scrollLeft - shown() * el.clientWidth) >= 1) glide(shown(), "instant");
    else publish();
  };
  const resize = new ResizeObserver(() => {
    if (!gliding) glide(shown(), "instant");
  });

  glide(shown(), "instant");
  el.addEventListener("scroll", onScroll, { passive: true });
  resize.observe(el);
  return {
    glide,
    stop: () => {
      stopGliding();
      resize.disconnect();
      el.removeEventListener("scroll", onScroll);
    },
  };
}

/**
 * The sidebar's nav, one page per module side by side. Opening a module (the rail, the phone's
 * switcher, `g f`) glides the pages there; they don't scroll under a swipe, and the page shown
 * always follows the URL, never the other way round. The pages' position is `--module-at` on
 * the sidebar (0 on the first page, 1 on the second, fractions between), so the phone
 * switcher's pill moves with them. Pages other than the shown one are inert and hidden from
 * assistive tech.
 */
export function ModulePager({ pages }: { pages: Record<ModuleId, ReactNode> }) {
  const modules = useModules();
  const current = useCurrentModule();
  const index = Math.max(
    0,
    modules.findIndex((module) => module.id === current),
  );
  const pager = useRef<HTMLDivElement>(null);
  const driver = useRef<ReturnType<typeof drivePages>>(null);
  const shown = useRef(index);
  shown.current = index;

  useLayoutEffect(() => {
    const el = pager.current;
    const root = el?.closest<HTMLElement>('[data-slot="sidebar"]');
    if (!el || !root) return;
    const driven = drivePages(el, root, () => shown.current);
    driver.current = driven;
    return () => {
      driven.stop();
      driver.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    driver.current?.glide(index, glideMotion());
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
