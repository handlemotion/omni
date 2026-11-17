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

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const DEFAULTS: Record<string, string> = {
  "content-security-policy": API_CSP,
  "strict-transport-security": "max-age=63072000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "permissions-policy": PERMISSIONS_POLICY,
};

export const securityHeaders = createMiddleware(async (c, next) => {
  await next();
  if (c.res.status === 101) return;
  const response = new Response(c.res.body, c.res);
  for (const [name, value] of Object.entries(DEFAULTS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  c.res = response;
});
