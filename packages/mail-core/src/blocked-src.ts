/**
 * Where the sanitizer leaves a blocked remote image's proxied URL; the client swaps it into `src`
 * when the reader loads remote images.
 */
export const BLOCKED_SRC_ATTR = "data-omni-src";
