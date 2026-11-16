// What a page shows in place of content that failed (ADR 0046): the failure's kind picks the
// figure, the title and the way out, as an empty state draws them. The same screen fills the whole
// window (the root route, where the shell itself may be what failed) or a module's pane (the shell
// stays). Reporting and the stale-build reload happen where the error is caught (the router's
// `defaultOnCatch`); this only draws the page, and a stale build that could not reload gets Reload.
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import { EmptyState } from "@/components/empty/empty-state";
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { classify } from "@/lib/failure.ts";

export function ErrorScreen(props: { error: unknown; reset: () => void }) {
  const failure = useMemo(() => classify(props.error), [props.error]);
  const retry = useRetry(props.reset);
  switch (failure.kind) {
    case "not_found":
      return <NotFoundState />;
    case "permission":
      return (
        <EmptyState figure="padlock" title="No access">
          <HomeLink />
        </EmptyState>
      );
    case "offline":
      return (
        <EmptyState figure="plug" title="You're offline">
          <RetryButton retry={retry} />
        </EmptyState>
      );
    default:
      return (
        <EmptyState figure="exploded" title="Something went wrong" meta={failure.requestId}>
          {(failure.retryable || failure.kind === "server") && <RetryButton retry={retry} />}
          <Button size="sm" intent="outline" onPress={() => window.location.reload()}>
            Reload
          </Button>
        </EmptyState>
      );
  }
}

export function NotFoundState() {
  return (
    <EmptyState figure="loupe" title="Not found">
      <HomeLink />
    </EmptyState>
  );
}

/** The whole window, for the root route: works with no shell around it. */
export function FullWindow(props: { children: ReactNode }) {
  return <div className="flex h-svh flex-col bg-background">{props.children}</div>;
}

// A full navigation where the shell is gone, a router one inside it (React Aria's provider).
function HomeLink() {
  return (
    <Link href="/" className={buttonStyles({ intent: "outline", size: "sm" })}>
      Go home
    </Link>
  );
}

function RetryButton(props: { retry: Retry }) {
  return (
    <Button size="sm" intent="outline" isPending={props.retry.pending} onPress={props.retry.run}>
      Try again
    </Button>
  );
}

interface Retry {
  pending: boolean;
  run: () => void;
}

/**
 * Runs the failed loaders and queries again, then clears the boundary. A route boundary clears
 * itself once its match changes; a module boundary keyed on the location needs the reset.
 */
function useRetry(reset: () => void): Retry {
  const router = useRouter();
  const queries = useQueryErrorResetBoundary();
  const [pending, setPending] = useState(false);
  return {
    pending,
    run: () => {
      setPending(true);
      queries.reset();
      void router.invalidate().finally(() => {
        setPending(false);
        reset();
      });
    },
  };
}
