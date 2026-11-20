import * as Sentry from "@sentry/browser";
import {
  areaOf,
  capEvents,
  PRIVATE_DATA_COLLECTION,
  sampleTrace,
  scrubBreadcrumb,
  scrubEvent,
  scrubFields,
} from "@omni/mail-core/telemetry";

/** The header the Worker reads, logs, stores on outbox rows and echoes back. */
export const REQUEST_ID_HEADER = "x-request-id";

const UNACTIONABLE_ERRORS = [
  /^Failed to fetch$/,
  /^Load failed$/,
  /^NetworkError when attempting to fetch resource\.?$/,
  /^AbortError\b/,
  /The operation was aborted/,
  /Failed to fetch dynamically imported module/,
  /Importing a module script failed/,
  /error loading dynamically imported module/,
  /ResizeObserver loop/,
];

const EXTENSION_URLS = [/^(?:chrome|moz|safari(?:-web)?)-extension:\/\//];

export function initErrorReporting() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  const capErrors = capEvents();
  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || "production",
    dataCollection: PRIVATE_DATA_COLLECTION,
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampler: (context) => sampleTrace({ ...context, location: context.location ?? location }),
    ignoreErrors: UNACTIONABLE_ERRORS,
    denyUrls: EXTENSION_URLS,
    beforeSend: (event) => capErrors(scrubEvent(withArea(event))),
    beforeSendSpan: (span) => scrubFields(span),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
}

function withArea<E extends { tags?: Record<string, unknown> }>(event: E) {
  return { ...event, tags: { area: areaOf(location.pathname), ...event.tags } };
}

/**
 * `fetch` that gives every API call its own request ID, so one click can be followed from the
 * browser through the Worker to the mail service. A failed call is tagged with its ID in Sentry.
 */
export const tracedFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  if (!headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, crypto.randomUUID());
  const requestId = headers.get(REQUEST_ID_HEADER)!;
  Sentry.addBreadcrumb({ category: "api", message: requestId, level: "info" });
  const response = await fetch(input, { ...init, headers });
  if (response.status >= 500) Sentry.setTag("last_failed_request_id", requestId);
  return response;
};
