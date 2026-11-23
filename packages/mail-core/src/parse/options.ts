export const PARSER_OPTIONS = {
  keepCidLinks: true,
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipImageLinks: true,
} as const;

/** Parts a bounce returns the original message in (RFC 3462). */
export const RETURNED_PARTS = new Set(["text/rfc822-headers", "message/rfc822"]);
