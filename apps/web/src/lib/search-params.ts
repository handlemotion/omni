// URL search params per route. Invalid values fall back instead of throwing, so a hand-edited or
// stale link still opens. `zod/mini` because these load with the app's entry chunk on every
// route, and full zod is most of that chunk's weight.
import * as z from "zod/mini";
// `z.catch`, renamed: a parsing fallback, not a promise handler.
import { catch as fallback } from "zod/mini";
import { HELPDESK_VIEWS, LANES } from "./types.ts";

const optional = <T extends z.ZodMiniType>(schema: T) => fallback(z.optional(schema), undefined);
const optionalId = optional(z.string().check(z.minLength(1)));

export const loginSearch = z.object({
  redirect: optional(z.string()),
  /**
   * `magic_link` (expired or used link), or a
   * Better Auth OAuth code from Google sign-in (`access_denied`; `SIGN_UP_REQUIRES_INVITATION`
   * on an install with `SIGN_UP=invitation`).
   */
  error: optional(z.string()),
});

export const inboxSearch = z.object({
  mailbox: optionalId,
  lane: optional(z.enum(LANES)),
  /** A shared inbox's helpdesk view (with `mailbox`): Unassigned, Mine, Open, … (ADR 0021). */
  view: optional(z.enum(HELPDESK_VIEWS)),
  /** Only conversations with this tag (a `tags.id` of the inbox). */
  tag: optionalId,
});

export const listSearch = z.object({ mailbox: optionalId });

/** A CRM list (ADR 0039): `q` searches it on the server. */
export const crmListSearch = z.object({ mailbox: optionalId, q: optional(z.string()) });

/** The deals: the board unless `view=list`. */
export const crmDealsSearch = z.object({
  mailbox: optionalId,
  q: optional(z.string()),
  view: optional(z.enum(["board", "list"])),
});
/**
 * A Storage folder's page: the mailbox the switcher keeps, and the file open in the preview or the
 * file whose comments are open (one panel at a time).
 */
export const filesSearch = z.object({
  mailbox: optionalId,
  file: optionalId,
  comments: optionalId,
});

export const draftsSearch = z.object({
  mailbox: optionalId,
  /** A new message's draft to open in the compose dialog; dropped once it has. */
  draft: optionalId,
});

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

/** A shared link's page: `node`, a folder inside what was shared. */
/** A shared link: the folder inside it (`node`), and the file open in the preview. */
export const linkSearch = z.object({ node: optionalId, file: optionalId, comments: optionalId });
