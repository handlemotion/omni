// The frame every Storage screen shares, on the mail lists' grid: a 48px header (the title or the
// breadcrumbs, an optional caption, then the screen's actions 10px from the right edge) over the
// content, which scrolls on its own. In the app it starts with Back, Forward and the sidebar toggle;
// a shared link's page has no app around it, so none.
import type { ReactNode } from "react";
import { PageNav, usePageNavShown } from "@/components/shell/page-nav";

export function StorageFrame(props: {
  /** The header's leading part: a heading, or breadcrumbs. */
  title: ReactNode;
  /** A short line after the title, as the mail lists' headers have. */
  caption?: ReactNode;
  actions?: ReactNode;
  /** False outside the app shell (a shared link's page). */
  sidebar?: boolean;
  children: ReactNode;
}) {
  const header = (toggle: ReactNode, inset: string) => (
    <header className={`flex h-12 shrink-0 items-center gap-2 border-b pe-2.5 ${inset}`}>
      {toggle}
      <div className="flex min-w-0 items-center">{props.title}</div>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
        {props.caption}
      </span>
      {props.actions && <div className="flex shrink-0 items-center gap-1.5">{props.actions}</div>}
    </header>
  );
  return (
    // Outside the shell it fills what the link page's bar leaves.
    <section
      className={`relative flex min-h-0 min-w-0 flex-col ${props.sidebar === false ? "flex-1" : "h-svh"}`}
    >
      {props.sidebar === false ? header(null, "ps-5") : <ShellHeader header={header} />}
      {props.children}
    </section>
  );
}

/** The header in the app shell: the sidebar toggle starts it while the sidebar is closed; with
 *  none, the title starts 20px in. */
function ShellHeader(props: { header: (toggle: ReactNode, inset: string) => ReactNode }) {
  const shown = usePageNavShown();
  return props.header(<PageNav />, shown ? "ps-2.5" : "ps-5");
}
