// Leaves a mailing list from the message it sent (List-Unsubscribe). One-click lists (RFC 8058)
// get their POST from here, without the reader's cookies or IP; a mailto list gets its message
// through the outbox like any send. A list that only offers a page is opened by the app.
import { unsubscribeMethod } from "@omni/mail-core/unsubscribe";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { checkDestination, type ProxyOptions } from "../image-proxy.ts";
import { limitPerMember } from "../rate-limiter.ts";
import { zValidator } from "../validator.ts";
import { enqueueSend, sendResponse, threadMessage } from "./compose.ts";
import { idempotencyHeader } from "./mail.ts";

/** How long the list's server has to answer the one-click POST, redirects included. */
const POST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/**
 * The RFC 8058 POST. The URL comes from mail, so every hop is checked as the image proxy checks
 * its own (no private networks, standard ports) and redirects are followed by hand. True when the
 * list accepted it.
 */
async function postOneClick(target: string, options: ProxyOptions) {
  const signal = AbortSignal.timeout(POST_TIMEOUT_MS);
  let url = new URL(target);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "https:" || (await checkDestination(url, options, signal))) return false;
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }).catch(() => null);
    if (!response) return false;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400) return response.ok;
    if (!location) return false;
    url = new URL(location, url);
  }
  return false;
}

const unsubscribeBody = z.object({
  /** The list message (`messages.id`); the thread's latest when absent. */
  messageId: z.string().min(1).optional(),
});

export const unsubscribe = new Hono<AppEnv>().post(
  "/threads/:id/unsubscribe",
  limitPerMember("send"),
  zValidator("header", idempotencyHeader),
  zValidator("json", unsubscribeBody),
  async (c) => {
    const { found, message } = await threadMessage(c, c.req.param("id"), c.req.valid("json"));
    const method = unsubscribeMethod(message.listUnsubscribe, message.listUnsubscribeOneClick);
    if (!method || method.kind === "link") {
      return apiError(c, "unprocessable_entity", "this message has no one-step unsubscribe");
    }
    if (method.kind === "mail") {
      const action = await enqueueSend(
        c,
        { orgId: found.orgId, mailboxId: found.mailboxId, kind: found.mailboxKind },
        {
          from: found.mailboxAddress,
          to: [method.to],
          subject: method.subject,
          text: method.body,
          attachments: [],
        },
        c.req.valid("header")["idempotency-key"],
      );
      return c.json({ kind: "mail" as const, ...sendResponse(action) }, 202);
    }
    const accepted = await postOneClick(method.url, {
      dohUrl: c.var.config.IMAGE_PROXY_DOH_URL,
    });
    if (!accepted) {
      return apiError(c, "bad_gateway", "the list did not accept the unsubscribe");
    }
    return c.json({ kind: "post" as const }, 200);
  },
);
