import {
  MAIL_PING_PATH,
  PROVISION_DOMAIN_PATH,
  PROVISION_MAILBOX_PATH,
  provisionDomainBodySchema,
  provisionMailboxBodySchema,
} from "@omni/contracts";
import {
  DEFAULT_MAX_AGE_SECONDS,
  isValidRequestId,
  REQUEST_ID_HEADER,
  verifyRequest,
} from "@omni/crypto";
import { type Context, Hono } from "hono";
import { routePath } from "hono/route";
import type { z } from "zod";
import type { Logger } from "./log.ts";
import { ProvisionError, type Provisioner } from "./provisioning.ts";

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
  /**
   * The Worker wrote to `mail_actions`: run the outbox now instead of at the next poll.
   * `requestId` is the Worker request that pinged, when it sent one.
   */
  onPing(trace: { requestId: string | null }): void;
  /** One `http.request` line per request. */
  log?: Logger;
  /** `ok: false` answers 503, so a host stops routing to (or fails the deploy of) this machine. */
  health(): Promise<{ ok: boolean } & Record<string, unknown>>;
  /** Onboarding's domain and mailbox setup. Absent: those routes answer 404. */
  provisioner?: Provisioner;
  onError?(error: unknown): void;
}

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono();

  // The Worker's request ID rides `x-omni-request-id`, covered by the HMAC signature: on signed
  // routes it is trustworthy once `verify` passed (a forged or stripped one fails verification).
  // Logs carry the route pattern, never bodies.
  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path === "/health" && c.res.ok) return;
    deps.log?.info("http.request", {
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      durationMs: Date.now() - started,
      // A refused request's ID is unverified: whoever sent it chose it.
      requestId: c.res.status === 401 ? null : requestIdOf(c),
    });
  });

  app.get("/health", async (c) => {
    const health = await deps.health();
    return c.json(health, health.ok ? 200 : 503);
  });

  app.post(MAIL_PING_PATH, async (c) => {
    if (!(await deps.verify(c.req.raw))) return c.json({ error: "unauthorized" }, 401);
    deps.onPing({ requestId: requestIdOf(c) });
    return c.json({ ok: true }, 202);
  });

  /** Verifies the signature, then parses the JSON body; null when the response is already set. */
  async function signedBody<S extends z.ZodType>(c: Context, schema: S) {
    if (!(await deps.verify(c.req.raw))) return c.json({ error: "unauthorized" }, 401);
    if (!deps.provisioner) return c.json({ error: "not found" }, 404);
    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid body" }, 400);
    return parsed.data as z.output<S>;
  }

  async function answer(c: Context, task: () => Promise<unknown>) {
    try {
      return c.json(await task());
    } catch (error) {
      if (error instanceof ProvisionError) return c.json({ error: error.message }, error.status);
      deps.onError?.(error);
      return c.json({ error: "internal error" }, 500);
    }
  }

  app.post(PROVISION_DOMAIN_PATH, async (c) => {
    const body = await signedBody(c, provisionDomainBodySchema);
    if (body instanceof Response) return body;
    return answer(c, () => deps.provisioner!.domain(body.domain));
  });

  app.post(PROVISION_MAILBOX_PATH, async (c) => {
    const body = await signedBody(c, provisionMailboxBodySchema);
    if (body instanceof Response) return body;
    return answer(c, () => deps.provisioner!.mailbox(body));
  });

  return app;
}

/** The signed request ID; only meaningful after `verify` passed. */
function requestIdOf(c: Context): string | null {
  const value = c.req.header(REQUEST_ID_HEADER);
  return value && isValidRequestId(value) ? value : null;
}
