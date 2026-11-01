// Fetches remote images for sanitized mail HTML so the sender never sees the reader's IP,
// cookies or referrer. Email is untrusted: every hop is checked against private networks, and
// only raster images of bounded size come back.

const MAX_REDIRECTS = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8_000;
const CACHE_SECONDS = 24 * 60 * 60;

/** Raster formats only. SVG can carry script and external references, so it is never proxied. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export type ProxyFailure = {
  status: 400 | 403 | 413 | 415 | 502 | 504;
  reason: string;
};

export interface ProxyOptions {
  /** DNS-over-HTTPS JSON endpoint used to check where a hostname points. */
  dohUrl: string;
  /**
   * Test-only: one exact origin (e.g. `http://127.0.0.1:4567`) exempt from the address checks,
   * so e2e can serve images and redirects locally. Empty in every real deployment.
   */
  testAllowOrigin?: string;
}

/** Headers for any image we serve: never sniffed, never scripted, never framed elsewhere. */
export function imageHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-site",
  };
}

export function isProxiableImageType(contentType: string | null) {
  return IMAGE_TYPES.has((contentType ?? "").split(";")[0]!.trim().toLowerCase());
}

/** Serves `target` through the Cache API, fetching and checking it on a miss. */
export async function proxyImage(
  target: string,
  options: ProxyOptions,
): Promise<Response | ProxyFailure> {
  const cacheKey = new Request(`https://image-proxy.invalid/?url=${encodeURIComponent(target)}`);
  const cache = await caches.open("image-proxy");
  const hit = await cache.match(cacheKey);
  if (hit) return withCacheControl(hit, `private, max-age=${CACHE_SECONDS}`);

  const fetched = await fetchImage(target, options);
  if (!(fetched instanceof Response)) return fetched;
  // The Cache API skips `private` responses; the stored copy is public, readers get private.
  await cache.put(cacheKey, withCacheControl(fetched.clone(), `public, max-age=${CACHE_SECONDS}`));
  return fetched;
}

function withCacheControl(response: Response, value: string) {
  const headers = new Headers(response.headers);
  headers.set("cache-control", value);
  return new Response(response.body, { status: response.status, headers });
}

async function fetchImage(target: string, options: ProxyOptions): Promise<Response | ProxyFailure> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return { status: 400, reason: "invalid url" };
  }
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const blocked = await checkDestination(url, options, signal);
    if (blocked) return blocked;

    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        signal,
        // A fresh request: no cookies, credentials or referrer from the reader.
        headers: { accept: [...IMAGE_TYPES].join(", "), "user-agent": "Omni-Image-Proxy/1" },
      });
    } catch (error) {
      return signal.aborted
        ? { status: 504, reason: "upstream timed out" }
        : { status: 502, reason: `upstream failed: ${String(error)}` };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) return { status: 502, reason: "redirect without location" };
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 502, reason: `upstream returned ${response.status}` };
    }

    const contentType = response.headers.get("content-type");
    if (!isProxiableImageType(contentType)) {
      await response.body?.cancel();
      return { status: 415, reason: "not a raster image" };
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) {
      await response.body?.cancel();
      return { status: 413, reason: "image too large" };
    }
    const body = await readCapped(response, MAX_BYTES);
    if (!body) return { status: 413, reason: "image too large" };

    return new Response(body, {
      headers: {
        ...imageHeaders(contentType!.split(";")[0]!.trim().toLowerCase()),
        "content-length": String(body.byteLength),
        "cache-control": `private, max-age=${CACHE_SECONDS}`,
      },
    });
  }
  return { status: 403, reason: "too many redirects" };
}

async function readCapped(response: Response, maxBytes: number) {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Null when the URL may be fetched; otherwise why not. Runs on every redirect hop. */
async function checkDestination(
  url: URL,
  options: ProxyOptions,
  signal: AbortSignal,
): Promise<ProxyFailure | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: 400, reason: "only http and https" };
  }
  if (url.username || url.password) return { status: 403, reason: "credentials in url" };
  if (options.testAllowOrigin && url.origin === options.testAllowOrigin) return null;
  // Standard ports only: nothing reaches an admin or database port by URL.
  if (url.port !== "") return { status: 403, reason: "non-standard port" };

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isIpLiteral(host)) {
    return isPublicIp(host) ? null : { status: 403, reason: "private address" };
  }
  if (
    !host.includes(".") ||
    /\.(localhost|local|internal|intranet|lan|home|corp|arpa|invalid|test)$/.test(host) ||
    host === "metadata.google.internal"
  ) {
    return { status: 403, reason: "private host" };
  }

  const addresses = await resolve(host, options.dohUrl, signal);
  if (addresses === null) return { status: 502, reason: "dns lookup failed" };
  if (addresses.length === 0) return { status: 502, reason: "host does not resolve" };
  if (!addresses.every(isPublicIp)) return { status: 403, reason: "private address" };
  return null;
}

/** A and AAAA records over DNS-over-HTTPS (JSON). Null when the lookup itself failed. */
async function resolve(host: string, dohUrl: string, signal: AbortSignal) {
  try {
    const answers = await Promise.all(
      ["A", "AAAA"].map(async (type) => {
        const url = new URL(dohUrl);
        url.searchParams.set("name", host);
        url.searchParams.set("type", type);
        const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal });
        if (!response.ok) throw new Error(`doh ${response.status}`);
        const json = (await response.json()) as { Answer?: { type: number; data: string }[] };
        return (json.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
      }),
    );
    return answers.flat();
  } catch {
    return null;
  }
}

function isIpLiteral(host: string) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
}

/** Only globally routable unicast addresses pass. Anything unparsable is treated as private. */
export function isPublicIp(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return isPublicIpv4(v4);
  const v6 = parseIpv6(address);
  if (!v6) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry an IPv4 address.
  const mapped =
    v6.slice(0, 5).every((x) => x === 0) && v6[5] === 0xffff
      ? v6
      : v6[0] === 0x64 && v6[1] === 0xff9b && v6.slice(2, 6).every((x) => x === 0)
        ? v6
        : null;
  if (mapped)
    return isPublicIpv4([mapped[6]! >> 8, mapped[6]! & 255, mapped[7]! >> 8, mapped[7]! & 255]);
  const first = v6[0]!;
  if (v6.every((x) => x === 0)) return false; // ::
  if (v6.slice(0, 7).every((x) => x === 0) && v6[7] === 1) return false; // ::1
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x2001 && v6[1] === 0x0db8) return false; // documentation
  return (first & 0xe000) === 0x2000; // 2000::/3 global unicast
}

function isPublicIpv4([a, b, c]: number[]): boolean {
  if (a === undefined || b === undefined || c === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function parseIpv6(address: string): number[] | null {
  let text = address.split("%")[0]!;
  // A trailing dotted IPv4 becomes two hextets.
  const dotted = text.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]!);
    if (!v4) return null;
    text = `${text.slice(0, -dotted[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
  return values.every((v) => !Number.isNaN(v)) ? values : null;
}
