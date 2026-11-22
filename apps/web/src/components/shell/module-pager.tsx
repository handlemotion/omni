import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useCurrentModule, useModules, type ModuleId } from "./module-switcher";

/**
 * The sidebar's nav, one page per module side by side on a track that slides to the shown
 * module's page. The frame clips rather than scrolls, so no swipe, focus or scroll can leave it
 * between pages; opening a module (the rail, the phone's switcher, `g f`) slides the track there,
 * and the page shown always follows the URL, never the other way round.
 * `--module-at` on the sidebar is the shown page's index, which the phone switcher's pill follows.
 * Pages other than the shown one are inert and hidden from assistive tech.
 * A page mounts the first time its module is shown and stays mounted, so the way back slides to
 * a drawn page. Mounting all of them up front loaded every module's sidebar data on each start
 * (Drive asks once per space and folder) before any of it could be seen.
 */
export function ModulePager({ pages }: { pages: Record<ModuleId, ReactNode> }) {
  const modules = useModules();
  const current = useCurrentModule();
  const index = Math.max(
    0,
    modules.findIndex((module) => module.id === current),
  );
  const pager = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<ReadonlySet<ModuleId>>(() => new Set([current]));
  if (!shown.has(current)) setShown(new Set([...shown, current]));
  useLayoutEffect(() => {
    pager.current
      ?.closest<HTMLElement>('[data-slot="sidebar"]')
      ?.style.setProperty("--module-at", String(index));
  }, [index]);

  return (
    <div ref={pager} data-slot="module-pager" className="-mx-3 flex min-h-0 flex-1 overflow-clip">
      <div
        data-slot="module-track"
        className="flex min-w-0 flex-1 transition-transform duration-300 ease-(--ease-out) motion-reduce:transition-none"
        style={{ transform: `translateX(${-index * 100}%)` }}
      >
        {modules.map((module, at) => (
          <div
            key={module.id}
            data-module-page={module.id}
            inert={at !== index}
            aria-hidden={at !== index || undefined}
            className="flex w-full flex-none flex-col gap-3 overflow-y-auto px-3 *:shrink-0"
          >
            {shown.has(module.id) && pages[module.id]}
          </div>
        ))}
      </div>
    </div>
  );
}
