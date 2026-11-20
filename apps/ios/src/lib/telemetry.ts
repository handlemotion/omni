import * as Sentry from "@sentry/react-native";
import {
  areaOf,
  capEvents,
  sampleTrace,
  scrubBreadcrumb,
  scrubEvent,
  scrubFields,
} from "@omni/mail-core/telemetry";
import { ApiError } from "./api.ts";

const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN;

const navigationIntegration = Sentry.reactNavigationIntegration({
  enableTimeToInitialDisplay: false,
});

let screen = "/";

/** Starts Sentry when the build has `EXPO_PUBLIC_SENTRY_DSN`; native crashes included. */
export function initErrorReporting() {
  if (!dsn) return;
  const capErrors = capEvents();
  Sentry.init({
    dsn,
    environment: process.env.EXPO_PUBLIC_SENTRY_ENVIRONMENT || "production",
    integrations: [navigationIntegration],
    tracesSampler: (context) =>
      sampleTrace({ ...context, location: { pathname: context.location?.pathname ?? screen } }),
    enableAutoSessionTracking: true,
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend: (event) => capErrors(scrubEvent(withArea(event))),
    beforeSendSpan: (span) => scrubFields(span),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
}

/** Records the route a screen change lands on, for the `area` tag and the trace sampler. */
export function trackScreen(pathname: string) {
  screen = pathname;
}

/** Wraps the root layout so render crashes are caught and reported. */
export const withErrorReporting = (component: React.ComponentType<Record<string, unknown>>) =>
  dsn ? Sentry.wrap(component) : component;

/** Hands Expo Router's navigation container to Sentry, so screen changes are traced by route. */
export function registerNavigation(container: unknown) {
  navigationIntegration.registerNavigationContainer(container);
}

/**
 * Reports a Drive transfer that failed for a reason worth a look: not a cancel, and not the
 * server refusing it on purpose (full, conflict, gone). Network failures count only once the
 * retries ran out.
 */
export function reportDriveFailure(
  stage: "upload" | "download" | "share" | "sync",
  error: unknown,
) {
  if (!dsn) return;
  if (error instanceof Error && /cancel|abort/i.test(`${error.name} ${error.message}`)) return;
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return;
  Sentry.captureException(error, { tags: { area: "drive", drive_stage: stage } });
}

function withArea<E extends { tags?: Record<string, unknown> }>(event: E) {
  return { ...event, tags: { area: areaOf(screen), ...event.tags } };
}
