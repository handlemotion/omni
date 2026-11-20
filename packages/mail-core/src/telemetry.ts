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

/**
 * Sentry's free plan is a small monthly quota shared by every project in the organization, so
 * traces are sampled and errors are capped. Errors are what we watch; a trace is context.
 * Drive (uploads, downloads, sharing, sync; `/drive/*` screens on iOS) is sampled five times as often as the rest while it
 * is the area under work. Raise a rate only after Sentry's Stats page shows room.
 */
export const TRACE_SAMPLE_RATES = { drive: 0.1, other: 0.02 } as const;

const UNTRACED =
  /^(?:[A-Z]+ )?(?:\/health\b|\/assets\/|\/api\/realtime\b|\/api\/auth\/get-session\b|\/favicon)|^Scheduled Cron \* \* \* \* \*$/;
const DRIVE_PATH = /(?:^|\s)(?:\/api\/storage|\/[^/\s]+\/files|\/s|\/drive)(?:\/|$)/;

/** The area a request path or span name belongs to, as a Sentry tag (`area`). */
export function areaOf(nameOrPath: string) {
  return DRIVE_PATH.test(nameOrPath) ? "drive" : "other";
}

/**
 * For Sentry's `tracesSampler`. With span streaming (the v11 default) a span starts with a
 * generic name (`GET`, a page-load placeholder), so the path comes from the request (Worker) or
 * the page's location (browser). A trace the caller already sampled keeps that decision, so a
 * web trace continues into the Worker instead of being sampled twice.
 */
export function sampleTrace(context: {
  name: string;
  location?: { pathname?: string } | undefined;
  normalizedRequest?: { url?: string | undefined; method?: string | undefined } | undefined;
  inheritOrSampleWith: (fallbackRate: number) => number;
}) {
  const subject = traceSubject(context);
  if (UNTRACED.test(subject)) return 0;
  return context.inheritOrSampleWith(TRACE_SAMPLE_RATES[areaOf(subject)]);
}

function traceSubject(context: Parameters<typeof sampleTrace>[0]) {
  const url = context.normalizedRequest?.url;
  if (url) return `${context.normalizedRequest?.method ?? ""} ${pathOf(url)}`.trim();
  if (context.location?.pathname) return context.location.pathname;
  return context.name;
}

function pathOf(url: string) {
  try {
    return new URL(url, "http://local").pathname;
  } catch {
    return url;
  }
}

/**
 * Most error events one process sends: a render loop or a retry storm then costs at most this
 * many from the monthly quota per tab or isolate, instead of all of it. Sentry still groups and
 * counts the issue from what got through.
 */
export const MAX_ERRORS_PER_PROCESS = 50;

/** Returns a `beforeSend` step that drops events once `max` have gone out. */
export function capEvents(max = MAX_ERRORS_PER_PROCESS) {
  let sent = 0;
  return <E>(event: E) => (sent++ < max ? event : null);
}
