import { WORKSPACE_HEADER } from "@omni/client";

const early = new Map<string, Promise<Response>>();
for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="fetch"]')) {
  const response = fetch(link.href, { credentials: "include" });
  response.catch(() => {});
  early.set(link.href, response);
}

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
export function takeStartupResponse(input: RequestInfo | URL, init?: RequestInit) {
  if (early.size === 0) return undefined satisfies Promise<Response> | undefined;
  const request = input instanceof Request ? input : undefined;
  if ((init?.method ?? request?.method ?? "GET") !== "GET")
    return undefined satisfies Promise<Response> | undefined;
  const url = new URL(request?.url ?? String(input), window.location.href).href;
  const response = early.get(url);
  early.delete(url);
  if (!response) return undefined satisfies Promise<Response> | undefined;
  const wanted = new Headers(init?.headers ?? request?.headers).get(WORKSPACE_HEADER);
  if (!wanted) return response satisfies Promise<Response> | undefined;
  return response.then((r) => {
    const answered = r.headers.get(WORKSPACE_HEADER);
    if (!answered || answered === wanted) return r;
    void r.body?.cancel();
    return fetch(input, init);
  }) satisfies Promise<Response> | undefined;
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
