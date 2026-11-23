import {
  DNS_LOOKUP_PATH,
  dnsLookupBodySchema,
  GOOGLE_CALENDAR_EVENTS_PATH,
  GOOGLE_CALENDAR_LIST_PATH,
  GOOGLE_CONNECT_PATH,
  GOOGLE_DISCONNECT_PATH,
  type GoogleCalendarEventsBody,
  type GoogleCalendarEventsResult,
  type GoogleCalendarListBody,
  type GoogleCalendarListResult,
  googleCalendarEventsBodySchema,
  googleCalendarListBodySchema,
  type GoogleConnectBody,
  type GoogleConnectResult,
  googleConnectBodySchema,
  type GoogleDisconnectBody,
  googleDisconnectBodySchema,
  MAILBOX_DISCONNECT_PATH,
  type HostedDisconnectBody,
  hostedDisconnectBodySchema,
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
import { DnsLookupError, type DnsLookup } from "./dns.ts";
import type { Logger } from "./log.ts";
import { ProvisionError, type Provisioner } from "./provisioning.ts";

/** Decides whether a request really came from the Worker. */
export type RequestVerifier = (request: Request) => Promise<boolean>;

/**
 * The HMAC + timestamp check from `@omni/crypto` (never hand-roll a second one). A nonce, when
 * the sender includes one, is accepted once within the signature window.
 */
export function hmacVerifier(
  secret: string,
  options: { maxAgeSeconds?: number; onReject?: (reason: string) => void } = {},
) {
  const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const seen = new Map<string, number>();
  return (async (request) => {
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
    seen.set(result.nonce, now + 2 * maxAgeSeconds * 1000);
    return true;
  }) satisfies RequestVerifier;
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
  /** Connects a Google account from an OAuth code. Absent: that route answers 404. */
  connectGoogle?(input: GoogleConnectBody): Promise<GoogleConnectResult>;
  /** Disconnects a Google account. Absent: that route answers 404. */
  disconnectGoogle?(input: GoogleDisconnectBody): Promise<{ mailboxId: string }>;
  /** One page of a Gmail inbox's Google Calendar, for the Worker's sync. Absent: 404. */
  googleCalendarEvents?(input: GoogleCalendarEventsBody): Promise<GoogleCalendarEventsResult>;
  /** A Gmail inbox's Google calendar list, for the Worker's sync. Absent: 404. */
  googleCalendarList?(input: GoogleCalendarListBody): Promise<GoogleCalendarListResult>;
  /** Disconnects any mailbox of an org, keeping its mail at the host. Absent: 404. */
  disconnectMailbox?(input: HostedDisconnectBody): Promise<{ mailboxId: string }>;
  /** Authoritative DNS lookups for domain verification. Absent: that route answers 404. */
  dns?: DnsLookup;
  onError?(error: unknown): void;
}

export function createApp(deps: HttpDeps) {
  const app = new Hono();

  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    if (c.req.path === "/health" && c.res.ok) return;
    deps.log?.info("http.request", {
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      durationMs: Date.now() - started,
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

  async function answer(c: Context, task: () => Promise<unknown>) {
    try {
      return c.json(await task());
    } catch (error) {
      if (error instanceof ProvisionError) return c.json({ error: error.message }, error.status);
      if (error instanceof DnsLookupError) return c.json({ error: error.message }, 400);
      deps.onError?.(error);
      return c.json({ error: "internal error" }, 500);
    }
  }

  function signedRoute<S extends z.ZodType>(
    path: string,
    schema: S,
    handle: ((body: z.output<S>) => Promise<unknown>) | undefined,
  ) {
    app.post(path, async (c) => {
      if (!(await deps.verify(c.req.raw))) return c.json({ error: "unauthorized" }, 401);
      if (!handle) return c.json({ error: "not found" }, 404);
      const parsed = schema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "invalid body" }, 400);
      return answer(c, () => handle(parsed.data as z.output<S>));
    });
  }

  const { provisioner } = deps;
  signedRoute(
    PROVISION_DOMAIN_PATH,
    provisionDomainBodySchema,
    provisioner && ((body) => provisioner.domain(body.domain, { add: body.add })),
  );
  signedRoute(
    PROVISION_MAILBOX_PATH,
    provisionMailboxBodySchema,
    provisioner && ((body) => provisioner.mailbox(body)),
  );
  signedRoute(GOOGLE_CONNECT_PATH, googleConnectBodySchema, deps.connectGoogle?.bind(deps));
  signedRoute(
    GOOGLE_DISCONNECT_PATH,
    googleDisconnectBodySchema,
    deps.disconnectGoogle?.bind(deps),
  );
  signedRoute(
    GOOGLE_CALENDAR_EVENTS_PATH,
    googleCalendarEventsBodySchema,
    deps.googleCalendarEvents?.bind(deps),
  );
  signedRoute(
    GOOGLE_CALENDAR_LIST_PATH,
    googleCalendarListBodySchema,
    deps.googleCalendarList?.bind(deps),
  );
  signedRoute(
    MAILBOX_DISCONNECT_PATH,
    hostedDisconnectBodySchema,
    deps.disconnectMailbox?.bind(deps),
  );
  signedRoute(DNS_LOOKUP_PATH, dnsLookupBodySchema, deps.dns);

  return app satisfies Hono;
}

function requestIdOf(c: Context) {
  const value = c.req.header(REQUEST_ID_HEADER);
  return value && isValidRequestId(value) ? value : null;
}
