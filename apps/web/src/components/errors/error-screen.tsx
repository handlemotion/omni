import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EmptyState } from "@/components/empty/empty-state";
import { Button, buttonStyles } from "@/components/ui/button";
import { Link } from "@/components/ui/link";
import { useConnectivity } from "@/hooks/use-connectivity.ts";
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
      return <OfflineState retry={retry} />;
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

/** No answer from the API and nothing cached to show in its place. */
export function OfflineState(props: { retry: Retry }) {
  useRetryOnReconnect(props.retry);
  return (
    <EmptyState figure="plug" title="You're offline">
      <RetryButton retry={props.retry} />
    </EmptyState>
  );
}

function useRetryOnReconnect(retry: Retry) {
  const { online } = useConnectivity();
  const run = useRef(retry.run);
  run.current = retry.run;
  const wasOffline = useRef(!online);
  useEffect(() => {
    if (!online) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      run.current();
    }
  }, [online]);
}

/** The whole window, for the root route: works with no shell around it. */
export function FullWindow(props: { children: ReactNode }) {
  return <div className="flex h-svh flex-col bg-background">{props.children}</div>;
}

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

export interface Retry {
  pending: boolean;
  run: () => void;
}

function useRetry(reset: () => void) {
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
  } satisfies Retry;
}
