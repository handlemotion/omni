import { MAIL_PING_PATH } from "@omni/contracts";
import { DEFAULT_MAX_AGE_SECONDS, verifyRequest } from "@omni/crypto";
import { Hono } from "hono";

/** Decides whether a request really came from the Worker. */
export type RequestVerifier = (request: Request) => Promise<boolean>;

/** Trusts nothing. For a service built without a secret (tests of the HTTP shell). */
export const rejectAll: RequestVerifier = async () => false;

/**
 * The HMAC + timestamp check from `@omni/crypto` (never hand-roll a second one). A nonce, when
 * the sender includes one, is accepted once within the signature window.
 */
export function hmacVerifier(
  secret: string,
  options: { maxAgeSeconds?: number; onReject?: (reason: string) => void } = {},
): RequestVerifier {
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const seen = new Map<string, number>();
  return async (request) => {
    const url = new URL(request.url);
    const body = new Uint8Array(await request.clone().arrayBuffer());
    const result = await verifyRequest({
      secret,
      method: request.method,
      path: url.pathname + url.search,
      body: body.length > 0 ? body : null,
      headers: request.headers,
      maxAgeSeconds,
    });
    if (!result.ok) {
      options.onReject?.(result.reason);
      return false;
    }
    if (result.nonce === null) return true;
    const now = Date.now();
    for (const [nonce, expires] of seen) if (expires < now) seen.delete(nonce);
    if (seen.has(result.nonce)) {
      options.onReject?.("replayed_nonce");
      return false;
    }
    // Twice the window: a timestamp may be up to maxAge in the future or in the past.
    seen.set(result.nonce, now + 2 * maxAgeSeconds * 1000);
    return true;
  };
}

export interface HttpDeps {
  verify: RequestVerifier;
  /** The Worker wrote to `mail_actions`: run the outbox now instead of at the next poll. */
  onPing(): void;
  /** `ok: false` answers 503, so a host stops routing to (or fails the deploy of) this machine. */
  health(): Promise<{ ok: boolean } & Record<string, unknown>>;
}

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const health = await deps.health();
    return c.json(health, health.ok ? 200 : 503);
  });

  app.post(MAIL_PING_PATH, async (c) => {
    if (!(await deps.verify(c.req.raw))) return c.json({ error: "unauthorized" }, 401);
    deps.onPing();
    return c.json({ ok: true }, 202);
  });

  return app;
}
