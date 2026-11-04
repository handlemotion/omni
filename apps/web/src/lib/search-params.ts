// URL search params per route. Invalid values fall back instead of throwing, so a hand-edited or
// stale link still opens. `zod/mini` because these load with the app's entry chunk on every
// route, and full zod is most of that chunk's weight.
import * as z from "zod/mini";
// `z.catch`, renamed: a parsing fallback, not a promise handler.
import { catch as fallback } from "zod/mini";
import { LANES } from "./types.ts";

const optional = <T extends z.ZodMiniType>(schema: T) => fallback(z.optional(schema), undefined);
const optionalId = optional(z.string().check(z.minLength(1)));

export const loginSearch = z.object({
  redirect: optional(z.string()),
  /**
   * `magic_link` (expired or used link), `no_organization` (signed in, no membership), or a
   * Better Auth OAuth code from Google sign-in (`access_denied`; `SIGN_UP_REQUIRES_INVITATION`
   * on an install with `SIGN_UP=invitation`).
   */
  error: optional(z.string()),
});

export const inboxSearch = z.object({
  mailbox: optionalId,
  lane: optional(z.enum(LANES)),
});

export const listSearch = z.object({ mailbox: optionalId });

export const searchSearch = z.object({
  q: fallback(z._default(z.string(), ""), ""),
  mailbox: optionalId,
});

export const composeSearch = z.object({
  mailbox: optionalId,
  to: optional(z.string()),
  subject: optional(z.string()),
});

/** The confirmation link mailed to a new sign-in email (ADR 0014). */
export const verifySignInEmailSearch = z.object({ token: optional(z.string()) });
