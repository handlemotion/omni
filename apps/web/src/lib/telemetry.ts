// Error reporting and request IDs for the web app. Sentry starts only when the build had
// VITE_SENTRY_DSN (validated in vite.config.ts); events are scrubbed of mail content, addresses,
// credentials and query strings first, and the SDK collects no headers, cookies or bodies.
import * as Sentry from "@sentry/browser";
import { PRIVATE_DATA_COLLECTION, scrubBreadcrumb, scrubEvent } from "@omni/mail-core/telemetry";

/** The header the Worker reads, logs, stores on outbox rows and echoes back. */
export const REQUEST_ID_HEADER = "x-request-id";

export function initErrorReporting() {
  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;
  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT || "production",
    dataCollection: PRIVATE_DATA_COLLECTION,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  });
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
