// The web build's hashed files (`/assets/*`). The Worker runs first for them (wrangler.jsonc) only
// so a file the deployed build lacks answers 404, not the single-page fallback's index.html. A tab
// or desktop window open across a deploy asks for its old build's chunks; with index.html it got
// "'text/html' is not a valid JavaScript MIME type" and no way to tell that from a bug, and a cache
// could keep HTML under a .js name. Files that exist pass through untouched, headers included.

export function isBuildAsset(request: Request) {
  return new URL(request.url).pathname.startsWith("/assets/");
}

export async function serveBuildAsset(request: Request, assets: Fetcher) {
  const response = await assets.fetch(request);
  // The binding applies `not_found_handling` too: a missing file comes back as the app's HTML.
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // The next deploy may add this very path; nothing should remember the miss.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
