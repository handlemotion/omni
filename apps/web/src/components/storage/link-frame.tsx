// The frame of `/s/<shareId>`, whatever the link opens (a file, a folder, nothing): a 48px bar,
// the app's own header height, with Omni's mark and name, and Sign in for a visitor without a
// session, which comes back to this link. Signed in, the bar holds only the name.
import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { IconRedirectArrow } from "@/components/icons";
import { buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { useSession } from "@/hooks/use-session.ts";

export function LinkFrame(props: { children: ReactNode }) {
  return (
    <div className="flex h-svh flex-col bg-background">
      <LinkBar />
      <main className="flex min-h-0 flex-1 flex-col">{props.children}</main>
    </div>
  );
}

function LinkBar() {
  const session = useSession();
  const here = useLocation({ select: (location) => location.href });
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b ps-2.5 pe-2.5">
      <IconRedirectArrow />
      <span className="flex-1 text-sm text-foreground">Omni</span>
      {/* Only once the session is known to be absent, so a signed-in reader never sees it flash. */}
      {session.data === null && (
        <Link
          href={`/login?redirect=${encodeURIComponent(here)}`}
          className={buttonStyles({ intent: "outline", size: "sm" })}
        >
          Sign in
        </Link>
      )}
    </header>
  );
}
