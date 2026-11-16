// The answers `index.html` preloads (session, shell data, the Inbox's first page) start with
// the page, before any script runs; a Drive folder's first page starts as this module does.
// They are taken here as the app starts and each answers the
// first GET for its URL, until the first screen has loaded or the session changes, whichever
// comes first (`dropStartupResponses`). Left to the browser, an unused preload waits for the
// page's whole life and answers a much later request with what was true at load: a sign-in that
// went to /join and was accepted later opened a shell built from its pre-membership answers.

import { WORKSPACE_HEADER } from "@omni/client";

const early = new Map<string, Promise<Response>>();
for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="fetch"]')) {
  // Same URL and credentials mode as the preload, so this takes its answer, not a new request.
  const response = fetch(link.href, { credentials: "include" });
  response.catch(() => {}); // A failure surfaces to the request that takes it.
  early.set(link.href, response);
}

// A Drive folder opened by its URL (ADR 0034): its first page starts here, beside the session
// check its route waits on, instead of after it. The URL is the one `storageListQuery` asks for
// (`lib/storage.ts`); a mismatch only means the request goes out again later.
const drive = /^\/[^/]+\/files\/(my|shared)(?:\/([^/]+))?\/?$/.exec(window.location.pathname);
if (drive) {
  const [, space, folder] = drive;
  const query = new URLSearchParams(
    folder
      ? { parent: decodeURIComponent(folder) }
      : { space: space === "my" ? "personal" : "shared" },
  );
  query.set("limit", "100");
  const url = new URL(`/api/storage/nodes?${query}`, window.location.href).href;
  const response = fetch(url, { credentials: "include" });
  response.catch(() => {});
  early.set(url, response);
}

/** The preloaded answer for this request, once; `undefined` sends it to the network. */
export function takeStartupResponse(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> | undefined {
  if (early.size === 0) return undefined;
  const request = input instanceof Request ? input : undefined;
  if ((init?.method ?? request?.method ?? "GET") !== "GET") return undefined;
  const url = new URL(request?.url ?? String(input), window.location.href).href;
  const response = early.get(url);
  early.delete(url);
  if (!response) return undefined;
  // A preload carries no header, so the Worker answered for the session's workspace. One that
  // says it answered for another workspace than this tab's goes again, naming it (ADR 0043).
  const wanted = new Headers(init?.headers ?? request?.headers).get(WORKSPACE_HEADER);
  if (!wanted) return response;
  return response.then((r) => {
    const answered = r.headers.get(WORKSPACE_HEADER);
    if (!answered || answered === wanted) return r;
    void r.body?.cancel();
    return fetch(input, init);
  });
}

/**
 * Forgets the answers nobody took: once the first screen has loaded every startup request has
 * taken its own, and after a sign-in, sign-out or switch they describe someone else.
 */
export function dropStartupResponses() {
  for (const response of early.values()) {
    void response.then(
      (r) => r.body?.cancel(),
      () => {},
    );
  }
  early.clear();
}
