const REDACTED = "[redacted]";

/**
 * Sentry's `dataCollection` option (SDK v11+), which collects headers, cookies, bodies, query
 * parameters, user info and AI inputs/outputs unless told not to. Every Omni SDK passes this, so
 * the scrubber below is the second lock, not the only one.
 */
export const PRIVATE_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
} as const;

const SENSITIVE_KEY =
  /^(body|text|html|cleantext|snippet|subject|payload|raw|content|from|to|cc|bcc|replyto|address|addresses|email|emails|recipient|recipients|participants|password|pass|passwd|secret|token|apikey|authorization|cookie|cookies|setcookie|credentials|credentialsenc|dsn|key|signature|nonce|querystring|query)$/;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"']+|(?<![\w/])\/[^\s?#"']*)[?#][^\s"']*/gi;

const CREDENTIAL_PART = /(secret|token|password|apikey|credential|cookie|authorization|dsn)/;

function isSensitiveKey(key: string) {
  const normalized = key.replaceAll(/[-_]/g, "").toLowerCase();
  return SENSITIVE_KEY.test(normalized) || CREDENTIAL_PART.test(normalized);
}

const QUERY_PARAMS = /\nparams: [\s\S]*$/;

export function scrubString(value: string) {
  return value
    .replace(QUERY_PARAMS, "\nparams: [redacted]")
    .replace(URL_QUERY, "$1")
    .replace(EMAIL, "[email]");
}

const scrubValue: (value: unknown, depth: number, seen: WeakSet<object>) => unknown = (
  value,
  depth,
  seen,
) => {
  if (typeof value === "string") return scrubString(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 12 || seen.has(value)) return "[truncated]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[scrubString(key)] = isSensitiveKey(key) ? REDACTED : scrubValue(item, depth + 1, seen);
  }
  return out;
};

/** Scrubs anything structured (log fields, breadcrumb data). */
export function scrubFields<T>(value: T) {
  return scrubValue(value, 0, new WeakSet()) as T;
}

/**
 * For Sentry's `beforeSend` (and `beforeSendTransaction`): returns a scrubbed copy. Stack frame
 * code (`pre_context`, `context_line`, `post_context`) is source code, not data, and passes
 * through; local variables (`vars`) are dropped by the key rule only if named like content, so
 * the SDKs must keep `includeLocalVariables` off.
 */
export function scrubEvent<E extends object>(event: E) {
  const { user, request, ...rest } = event as {
    user?: { id?: unknown } | null;
    request?: { method?: unknown; url?: unknown } | null;
  };
  const scrubbed = scrubFields(rest) as Record<string, unknown>;
  if (user && user.id !== undefined) scrubbed.user = { id: user.id };
  if (request) {
    scrubbed.request = {
      ...(typeof request.method === "string" ? { method: request.method } : {}),
      ...(typeof request.url === "string" ? { url: scrubString(request.url) } : {}),
    };
  }
  return scrubbed as E;
}

/**
 * For Sentry's `beforeBreadcrumb`. Console breadcrumbs are dropped: they repeat log lines, and
 * an SDK's own console capture would bypass the log rules. Everything else is scrubbed.
 */
export const scrubBreadcrumb: <B extends { category?: string }>(breadcrumb: B) => B | null = (
  breadcrumb,
) => {
  if (breadcrumb.category === "console") return null;
  return scrubFields(breadcrumb);
};
