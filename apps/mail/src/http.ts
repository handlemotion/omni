import { Hono } from "hono";

/**
 * Decides whether a request really came from the Worker. The HMAC + timestamp check from
 * `@omni/crypto` plugs in here; never hand-roll a second verifier (AGENTS.md).
 */
export type RequestVerifier = (request: Request) => Promise<boolean>;

/** Until `@omni/crypto` lands, nothing is trusted. */
export const rejectAll: RequestVerifier = async () => false;

export interface HttpDeps {
  verify: RequestVerifier;
  /** The Worker wrote to `mail_actions`: run the outbox now instead of at the next poll. */
  onPing(): void;
  health(): { mailboxes: number; connected: number };
}

export function createApp(deps: HttpDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, ...deps.health() }));

  app.post("/ping", async (c) => {
    if (!(await deps.verify(c.req.raw))) return c.json({ error: "unauthorized" }, 401);
    deps.onPing();
    return c.json({ ok: true }, 202);
  });

  return app;
}
