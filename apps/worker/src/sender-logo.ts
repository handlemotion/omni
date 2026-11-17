// A sender's picture for avatars: their company's logo, or for a webmail address their Gravatar.
// Every fetch goes through the image proxy's checks (no private addresses, rasters only, bounded
// size), and each result, a miss included, is cached by domain or address hash so a list of
// threads costs one lookup per sender a week.
import {
  iconLinks,
  imageWidth,
  logoCandidates,
  type LogoSource,
} from "@omni/mail-core/sender-logo";
import {
  checkDestination,
  fetchImage,
  imageHeaders,
  type ProxyFailure,
  type ProxyOptions,
} from "./image-proxy.ts";

const FOUND_SECONDS = 7 * 24 * 60 * 60;
const MISSING_SECONDS = 24 * 60 * 60;
/** Wide enough to stay sharp in a 40px avatar on a 2x screen, wherever it is drawn smaller. */
const SHARP_WIDTH = 64;
/** Candidates tried, and the time they may take, before the best one so far is kept. */
const MAX_TRIES = 5;
const BUDGET_MS = 7_000;
/** The icons are linked from `<head>`, near the top of the page. */
const PAGE_BYTES = 256 * 1024;

export interface LogoOptions extends ProxyOptions {
  /** Icon service URL with `{domain}`, or `off`. */
  iconService: string;
  /** Gravatar URL with `{hash}`, or `off`. */
  gravatar: string;
}

/** The logo for `source` through the Cache API: an image, a 404 when it has none, or why not. */
export const senderLogo: (
  source: LogoSource,
  options: LogoOptions,
) => Promise<Response | ProxyFailure> = async (source, options) => {
  const key =
    source.kind === "domain"
      ? `domain/${source.domain}`
      : `gravatar/${await sha256(source.address)}`;
  const cacheKey = new Request(`https://sender-logo.invalid/v1/${key}`);
  const cache = await caches.open("sender-logo");
  const hit = await cache.match(cacheKey);
  if (hit) return withCacheControl(hit, hit.ok ? FOUND_SECONDS : MISSING_SECONDS, "private");

  const wait = (await options.beforeFetch?.()) ?? 0;
  if (wait) return { status: 429, reason: "too many requests", retryAfter: wait };

  const image =
    source.kind === "domain"
      ? await domainLogo(source.domain, options)
      : await gravatar(key.slice("gravatar/".length), options);
  const response = image
    ? new Response(image.bytes, {
        headers: { ...imageHeaders(image.type), "content-length": String(image.bytes.byteLength) },
      })
    : new Response(null, { status: 404 });
  // The Cache API skips `private` responses; the stored copy is public, readers get private.
  const seconds = image ? FOUND_SECONDS : MISSING_SECONDS;
  await cache.put(cacheKey, withCacheControl(response.clone(), seconds, "public"));
  return withCacheControl(response, seconds, "private");
};

interface Image {
  bytes: Uint8Array;
  type: string;
  width: number;
}

const gravatar: (hash: string, options: LogoOptions) => Promise<Image | null> = async (
  hash,
  options,
) => {
  if (options.gravatar === "off") return null;
  return fetchCandidate(options.gravatar.replaceAll("{hash}", hash), options);
};

/** The first sharp icon among the candidates, or the widest one found in the time allowed. */
const domainLogo: (domain: string, options: LogoOptions) => Promise<Image | null> = async (
  domain,
  options,
) => {
  const deadline = Date.now() + BUDGET_MS;
  const page = await fetchPage(`https://${domain}/`, options);
  const links = page ? iconLinks(page.html, page.url) : [];
  const service = options.iconService === "off" ? undefined : options.iconService;
  let best: Image | null = null;
  for (const url of logoCandidates(domain, links, service).slice(0, MAX_TRIES)) {
    if (Date.now() > deadline) break;
    const image = await fetchCandidate(url, options);
    if (image && image.width >= SHARP_WIDTH) return image;
    if (image && image.width > (best?.width ?? 0)) best = image;
  }
  return best;
};

const fetchCandidate: (url: string, options: ProxyOptions) => Promise<Image | null> = async (
  url,
  options,
) => {
  const response = await fetchImage(url, options);
  if (!(response instanceof Response)) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const width = imageWidth(bytes);
  if (!width) return null;
  return { bytes, type: response.headers.get("content-type")!, width };
};

/** A site's home page, its first bytes only, after the same per-hop checks as the proxy. */
async function fetchPage(target: string, options: ProxyOptions) {
  let url = new URL(target);
  const signal = AbortSignal.timeout(4_000);
  try {
    for (let hop = 0; hop <= 3; hop++) {
      if (await checkDestination(url, options, signal)) return null;
      const response = await fetch(url, {
        redirect: "manual",
        signal,
        headers: { accept: "text/html", "user-agent": "Omni-Image-Proxy/1" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) {
        await response.body?.cancel();
        return null;
      }
      return { html: await readHead(response), url: url.toString() };
    }
  } catch {
    // Unreachable, timed out or refused: the conventional paths are still worth trying.
  }
  return null;
}

async function readHead(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let html = "";
  while (html.length < PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) return html;
    html += decoder.decode(value, { stream: true });
    if (/<\/head>/i.test(html)) break;
  }
  await reader.cancel();
  return html;
}

function withCacheControl(response: Response, seconds: number, scope: "public" | "private") {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `${scope}, max-age=${seconds}`);
  return new Response(response.body, { status: response.status, headers });
}

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
