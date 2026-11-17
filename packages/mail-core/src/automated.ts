/**
 * `bounce`: a delivery report (failed or delayed delivery).
 * `auto-reply`: an automatic answer to a message (out of office, vacation, read receipt).
 * `auto-generated`: a message a system sent on its own (`Auto-Submitted: auto-generated`).
 */
export type AutomatedKind = "bounce" | "auto-reply" | "auto-generated";

export interface Automated {
  kind: AutomatedKind;
  /** For a bounce: the Message-ID (`<id@host>`) of the message that failed, when the report names it. */
  bouncedMessageId: string | null;
}

/**
 * Reads one top-level header by lowercase name: the unfolded value of its first occurrence,
 * or null when it is absent.
 */
export type HeaderLookup = (name: string) => string | null;

/**
 * Classifies a message as automated from its top-level headers and sender, or returns null
 * for mail a person wrote. Header signals only (RFC 3834, RFC 3464, RFC 8098 and the common
 * legacy ones); subject lines like "Out of office" are left alone, because a customer can
 * write them too.
 *
 * `X-Auto-Response-Suppress` is deliberately not a signal: Outlook sets it on meeting
 * invites and other mail a person sends.
 */
export const automatedKind: (
  header: HeaderLookup,
  fromAddress: string | null,
) => AutomatedKind | null = (header, fromAddress) => {
  const contentType = header("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("multipart/report")) {
    const reportType = /report-type\s*=\s*"?([\w-]+)/.exec(contentType)?.[1];
    if (reportType === "delivery-status") return "bounce";
    if (reportType === "disposition-notification") return "auto-reply";
  }
  if (header("x-failed-recipients") !== null) return "bounce";
  if (fromAddress?.toLowerCase().startsWith("mailer-daemon@")) return "bounce";

  const autoSubmitted = header("auto-submitted")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (autoSubmitted === "auto-replied") return "auto-reply";
  const precedence = (header("precedence") ?? header("x-precedence") ?? "").trim().toLowerCase();
  if (precedence === "auto_reply") return "auto-reply";
  for (const name of ["x-autoreply", "x-autorespond", "x-autoresponder"]) {
    const value = header(name)?.trim().toLowerCase();
    if (value !== undefined && value !== "no" && value !== "false") return "auto-reply";
  }
  if (autoSubmitted !== "" && autoSubmitted !== "no") return "auto-generated";
  return null;
};

/** Top-level headers `automatedKind` reads, so a parser that keeps only some still keeps these. */
export const AUTOMATED_HEADERS = [
  "content-type",
  "x-failed-recipients",
  "auto-submitted",
  "precedence",
  "x-precedence",
  "x-autoreply",
  "x-autorespond",
  "x-autoresponder",
] as const;

const RETURNED_MESSAGE_ID = /^message-id:[ \t]*(?:\r?\n[ \t]+)?(<[^<>\s]+>)/im;

/**
 * The Message-ID of the message a bounce returns. `sources` are where reports put the
 * original's headers, most reliable first: the `text/rfc822-headers` or `message/rfc822`
 * part (RFC 3462), then the body, where Exim and qmail paste a copy.
 */
export function bouncedMessageId(sources: readonly string[]) {
  for (const source of sources) {
    const match = RETURNED_MESSAGE_ID.exec(source);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}
