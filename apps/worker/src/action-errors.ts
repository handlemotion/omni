import type { MailActionKind } from "@omni/contracts";

// `mail_actions.last_error` is for operators: SMTP replies, hostnames, mailbox ids. Apps get one
// of these short sentences instead, picked by what the raw error says went wrong.
const rules: [RegExp, string][] = [
  [/invalid login|auth|credential|535|534/i, "The mail server rejected this mailbox's sign-in."],
  [
    /recipient|5\.1\.\d|550|553|554|mailbox unavailable|no such user/i,
    "The mail server rejected a recipient address.",
  ],
  [/too large|size|552/i, "The message is too large to send."],
  [/uidvalidity|stale/i, "The mail moved on the server before this could run. Try again."],
  [
    /timeout|timed out|econn|enotfound|eai_again|greeting|socket|network/i,
    "Could not reach the mail server.",
  ],
];

const fallback: Record<MailActionKind, string> = {
  send: "The message could not be sent.",
  archive: "The thread could not be archived on the mail server.",
  move: "The thread could not be moved on the mail server.",
  mark_read: "The read state could not be saved on the mail server.",
  mark_unread: "The read state could not be saved on the mail server.",
};

/** A short message an app can show for an action that failed with `lastError`. */
export function publicActionError(kind: MailActionKind, lastError: string): string {
  return rules.find(([pattern]) => pattern.test(lastError))?.[1] ?? fallback[kind];
}
