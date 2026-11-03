// Hardening headers on everything the Worker answers. The web app's files never reach the Worker
// (they are static assets); `apps/web/public/_headers` gives them the same HSTS, nosniff and
// permissions policy, plus the app's own CSP. Keep the shared values in step.
import { createMiddleware } from "hono/factory";

/** Powerful features the app never uses are off; passkeys stay on for our own origin. */
export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "browsing-topics=()",
  "camera=()",
  "display-capture=()",
  "geolocation=()",
  "gyroscope=()",
  "hid=()",
  "magnetometer=()",
  "microphone=()",
  "midi=()",
  "payment=()",
  "serial=()",
  "usb=()",
  "publickey-credentials-create=(self)",
  "publickey-credentials-get=(self)",
].join(", ");

/**
 * API answers are data, never documents: nothing in one may load or run, and no page may frame
 * it. Routes that serve a document or a file set their own CSP (message HTML, images), and win.
 */
const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const DEFAULTS: Record<string, string> = {
  "content-security-policy": API_CSP,
  // Two years, subdomains included. Browsers ignore it on plain http (local dev).
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": PERMISSIONS_POLICY,
};

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  // A websocket upgrade's response belongs to the runtime and cannot be rebuilt.
  if (c.res.status === 101) return;
  // Some responses (fetch, R2, Better Auth) carry immutable headers: copy before editing.
  const response = new Response(c.res.body, c.res);
  for (const [name, value] of Object.entries(DEFAULTS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  c.res = response;
});
