// Where a failure stops (ADR 0046). The root route's `errorComponent` takes the whole window; a
// module's content pane has its own boundary, so a crash there keeps the sidebar and title bar;
// a part that loads on its own chunk (a preview, a chart) falls back in place. Every boundary
// starts over when the location changes.
import { CatchBoundary, isNotFound, useLocation, useRouter } from "@tanstack/react-router";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { classify, reportFailure } from "@/lib/failure.ts";
import { ErrorScreen } from "./error-screen.tsx";

/**
 * The content pane under the shell: the error screen in place of the module's page. It catches
 * like a route's own boundary, through the router's `defaultOnCatch` (report, stale-build reload).
 */
export function ModuleBoundary(props: { children: ReactNode }) {
  const router = useRouter();
  const href = useLocation({ select: (location) => location.href });
  return (
    <CatchBoundary
      getResetKey={() => href}
      errorComponent={ErrorScreen}
      onCatch={(error, info) => {
        // A route's not-found belongs to the router's not-found handling, above this.
        if (isNotFound(error)) throw error;
        router.options.defaultOnCatch?.(error, info);
      }}
    >
      {props.children}
    </CatchBoundary>
  );
}

/**
 * A part of a page that may fail on its own: `fallback` in its place, the page unaffected. Outside
 * the router's boundaries, so it reports what it catches itself.
 */
export function Contain(props: { fallback: ReactNode; children: ReactNode }) {
  const href = useLocation({ select: (location) => location.href });
  return (
    <InlineBoundary resetKey={href} fallback={props.fallback}>
      {props.children}
    </InlineBoundary>
  );
}

interface InlineProps {
  resetKey: string;
  fallback: ReactNode;
  children: ReactNode;
}

interface InlineState {
  failed: boolean;
  resetKey: string;
}

// React has no hook for catching render errors; this is the one class component it takes.
class InlineBoundary extends Component<InlineProps, InlineState> {
  override state: InlineState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromProps(props: InlineProps, state: InlineState) {
    const result: Partial<InlineState> =
      props.resetKey === state.resetKey ? {} : { failed: false, resetKey: props.resetKey };
    return result;
  }

  static getDerivedStateFromError() {
    const result: Partial<InlineState> = { failed: true };
    return result;
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    reportFailure(classify(error));
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
