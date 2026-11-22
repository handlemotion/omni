const STORE = "omni-pdf-tiles-v1";
const KEEP = 500;

export interface StoredFirst {
  page: Blob;
  ratio: number;
  count: number;
}

const open = () =>
  typeof caches === "undefined" ? Promise.resolve(undefined) : caches.open(STORE);

function keyOf(url: string, version: string, page: number) {
  const key = new URL("/__omni/pdf-tile", window.location.origin);
  key.searchParams.set("u", new URL(url, window.location.origin).pathname);
  key.searchParams.set("v", version);
  key.searchParams.set("p", String(page));
  return key.toString();
}

/** The kept first page of this file version and its shape, or undefined. Never throws. */
export async function readFirst(url: string, version: string) {
  try {
    const first = await (await open())?.match(keyOf(url, version, 0));
    if (!first) return undefined;
    const ratio = Number(first.headers.get("x-ratio"));
    const count = Number(first.headers.get("x-count"));
    if (!(ratio > 0) || !(count > 0)) return undefined;
    return { page: await first.blob(), ratio, count } satisfies StoredFirst;
  } catch {
    return undefined;
  }
}

/** The kept pages 2 to `count + 1`, or undefined unless all are kept. Never throws. */
export async function readMore(url: string, version: string, count: number) {
  try {
    const store = await open();
    if (!store) return undefined;
    const kept = await Promise.all(
      Array.from({ length: count }, (_, i) => store.match(keyOf(url, version, i + 1))),
    );
    if (kept.some((page) => !page)) return undefined;
    return await Promise.all(kept.map((page) => page!.blob()));
  } catch {
    return undefined;
  }
}

let writes = 0;

/** Keeps a drawn first page for later visits. Best effort: a full store is no error. */
export async function writeFirst(url: string, version: string, first: StoredFirst) {
  await put(url, version, 0, first.page, {
    "x-ratio": String(first.ratio),
    "x-count": String(first.count),
  });
  if (writes++ % 25 === 0) await prune();
}

/** Keeps the drawn pages behind a first page. */
export async function writeMore(url: string, version: string, pages: Blob[]) {
  await Promise.all(pages.map((page, i) => put(url, version, i + 1, page, {})));
}

async function put(
  url: string,
  version: string,
  n: number,
  page: Blob,
  headers: Record<string, string>,
) {
  try {
    const store = await open();
    const type = page.type || "image/webp";
    await store?.put(
      keyOf(url, version, n),
      new Response(page, { headers: { "content-type": type, ...headers } }),
    );
  } catch {}
}

async function prune() {
  try {
    const store = await open();
    if (!store) return;
    const firsts = (await store.keys()).filter((key) => key.url.endsWith("&p=0"));
    for (const key of firsts.slice(0, Math.max(0, firsts.length - KEEP))) {
      const prefix = key.url.slice(0, -1);
      for (let page = 0; page < 3; page += 1) await store.delete(`${prefix}${page}`);
    }
  } catch {}
}

/** Drops every kept tile: another person signs in on this browser. */
export async function forgetPdfTiles() {
  try {
    if (typeof caches !== "undefined") await caches.delete(STORE);
  } catch {}
}
