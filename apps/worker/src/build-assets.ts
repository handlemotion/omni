export function isBuildAsset(request: Request) {
  return new URL(request.url).pathname.startsWith("/assets/");
}

export async function serveBuildAsset(request: Request, assets: Fetcher) {
  const response = await assets.fetch(request);
  if (!response.headers.get("content-type")?.startsWith("text/html")) return response;
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
