import * as z from "zod/mini";
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
  /**
   * A native app's sign-in callback (`omni:///?state=…`): the iOS app opens this page in a
   * browser sheet, and the session returns to the app there instead of staying in the browser.
   */
  callback: optional(z.string()),
});

export const inboxSearch = z.object({
  mailbox: optionalId,
  lane: optional(z.enum(LANES)),
  /** A shared inbox's helpdesk view (with `mailbox`): Unassigned, Mine, Open, …. */
  view: optional(z.enum(HELPDESK_VIEWS)),
  /** Only conversations with this tag (a `tags.id` of the inbox). */
  tag: optionalId,
});

export const listSearch = z.object({ mailbox: optionalId });

/** Drive's Search: `q` matches file and folder names on the server. */
export const fileSearchSearch = z.object({ mailbox: optionalId, q: optional(z.string()) });

const RECORD_SORTS = ["name", "created", "updated"] as const;
const DEAL_SORTS = [...RECORD_SORTS, "value", "closeOn", "stageEntered"] as const;
const isoDay = optional(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/)));
const amount = optional(z.number());

/** The tasks: mine unless `view` says all or done; `assignee` narrows all and done. */
export const crmTasksSearch = z.object({
  mailbox: optionalId,
  q: optional(z.string()),
  view: optional(z.enum(["mine", "all", "done"])),
  assignee: optionalId,
});

const crmListFields = {
  mailbox: optionalId,
  q: optional(z.string()),
  sort: optional(z.enum(RECORD_SORTS)),
  dir: optional(z.enum(["asc", "desc"])),
  owner: optionalId,
  archived: optional(z.literal("only")),
};

/**
 * A CRM list's view, all in the URL so a link reproduces it: `q` searches on the
 * server, then the sort, the owner (a member's id or `none`) and the archived view.
 */
export const crmCompaniesSearch = z.object(crmListFields);

/** People also filter by having a company (`with`) or not (`without`). */
export const crmPeopleSearch = z.object({
  ...crmListFields,
  company: optional(z.enum(["with", "without"])),
});

const crmDealFields = {
  ...crmListFields,
  sort: optional(z.enum(DEAL_SORTS)),
  stage: optionalId,
  closeAfter: isoDay,
  closeBefore: isoDay,
  minValue: amount,
  maxValue: amount,
};

/** The deals: the board unless `view=list`; a stage, a close window, a value range. */
export const crmDealsSearch = z.object({
  ...crmDealFields,
  view: optional(z.enum(["board", "list"])),
});

/** Projects: won deals. */
export const crmProjectsSearch = z.object(crmDealFields);

export type CrmCompaniesSearch = z.infer<typeof crmCompaniesSearch>;
export type CrmPeopleSearch = z.infer<typeof crmPeopleSearch>;
export type CrmDealsSearch = z.infer<typeof crmDealsSearch>;
export type CrmProjectsSearch = z.infer<typeof crmProjectsSearch>;
/**
 * A Storage folder's page: the mailbox the switcher keeps, and the file open in the preview or the
 * file whose comments are open (one panel at a time).
 */
export const filesSearch = z.object({
  mailbox: optionalId,
  file: optionalId,
  comments: optionalId,
});

/**
 * A company's or a deal's page: the folder open in its Files tab (inside the record's folder), and
 * the file open in the preview or whose comments are open, as a Drive folder's page has.
 */
export const crmRecordSearch = z.object({
  mailbox: optionalId,
  folder: optionalId,
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

/** The confirmation link mailed to a new sign-in email. */
export const verifySignInEmailSearch = z.object({ token: optional(z.string()) });

/** A shared link: the folder inside it (`node`), and the file open in the preview. */
export const linkSearch = z.object({ node: optionalId, file: optionalId, comments: optionalId });
