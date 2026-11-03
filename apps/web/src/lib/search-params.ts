// URL search params per route. Invalid values fall back instead of throwing, so a hand-edited or
// stale link still opens.
import { z } from "zod";
import { LANES } from "./types.ts";

const optionalId = z.string().min(1).optional().catch(undefined);

export const loginSearch = z.object({
  redirect: z.string().optional().catch(undefined),
  /**
   * `magic_link` (expired or used link), `no_organization` (signed in, no membership), or a
   * Better Auth OAuth code from Google sign-in (`SIGN_UP_REQUIRES_INVITATION`, `access_denied`).
   */
  error: z.string().optional().catch(undefined),
});

export const inboxSearch = z.object({
  mailbox: optionalId,
  lane: z.enum(LANES).optional().catch(undefined),
});

export const listSearch = z.object({ mailbox: optionalId });

export const searchSearch = z.object({
  q: z.string().default("").catch(""),
  mailbox: optionalId,
});

export const composeSearch = z.object({
  mailbox: optionalId,
  to: z.string().optional().catch(undefined),
  subject: z.string().optional().catch(undefined),
});
