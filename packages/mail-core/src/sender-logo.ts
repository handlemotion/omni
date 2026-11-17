import { domainOf, isWebmailDomain, normalizeAddress } from "./addresses.ts";

/** Where a sender's picture comes from: their own face, or their company's mark. */
export type LogoSource = { kind: "gravatar"; address: string } | { kind: "domain"; domain: string };

/** A webmail address says nothing about a company, so only its owner's Gravatar fits. */
export const logoSource: (address: string) => LogoSource | null = (address) => {
  const domain = domainOf(address);
  if (!domain || !domain.includes(".")) return null;
  if (isWebmailDomain(domain)) return { kind: "gravatar", address: normalizeAddress(address) };
  return domainLogoSource(domain);
};

/** A company's mark from one of its domains; none for a webmail domain. */
export const domainLogoSource: (domain: string) => LogoSource | null = (domain) => {
  const host = domain.trim().toLowerCase();
  if (!host.includes(".") || isWebmailDomain(host)) return null;
  return { kind: "domain", domain: registrableDomain(host) };
};

const SECOND_LEVELS = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go"]);

/**
 * The domain a company's site lives on: `mail.acme.co.uk` → `acme.co.uk`. Mail comes from
 * subdomains (`bounce.`, `em.`, `notifications.`) that serve no site and carry no icon.
 */
export function registrableDomain(domain: string) {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  const keep =
    labels.length > 2 && labels.at(-1)!.length === 2 && SECOND_LEVELS.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

export interface IconLink {
  url: string;
  /** The declared size in pixels; 0 when the page does not say. */
  size: number;
}

/**
 * The raster icons a page's `<link rel>` tags offer, largest first. An apple-touch-icon with no
 * `sizes` is 180px (what iOS asks for); SVG and Safari's mask icon are left out, since the image
 * proxy serves rasters only.
 */
export function iconLinks(html: string, pageUrl: string) {
  const links: IconLink[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag, "rel")?.toLowerCase() ?? "";
    const href = attribute(tag, "href");
    if (!href || !/(^|\s)(icon|apple-touch-icon(-precomposed)?)(\s|$)/.test(rel)) continue;
    const type = attribute(tag, "type")?.toLowerCase() ?? "";
    if (type.includes("svg") || /\.svg(\?|#|$)/i.test(href) || href.startsWith("data:")) continue;
    let url: URL;
    try {
      url = new URL(decodeEntities(href), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const declared = Math.max(
      0,
      ...[...(attribute(tag, "sizes") ?? "").matchAll(/(\d+)x(\d+)/gi)].map((m) => Number(m[1])),
    );
    const size = declared || (rel.includes("apple-touch-icon") ? 180 : 0);
    links.push({ url: url.toString(), size });
  }
  return links.toSorted((a, b) => b.size - a.size) satisfies IconLink[];
}

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "").trim() : null;
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/g, "/");
}

/**
 * The URLs to try for a domain's logo, best first: what its home page links, then the
 * conventional paths. `fallback` is an icon service URL with `{domain}` in it, tried before the
 * 16px `/favicon.ico`.
 */
export function logoCandidates(domain: string, links: IconLink[], fallback?: string) {
  const origin = `https://${domain}`;
  const urls = [
    ...links.map((l) => l.url),
    `${origin}/apple-touch-icon.png`,
    ...(fallback ? [fallback.replaceAll("{domain}", encodeURIComponent(domain))] : []),
    `${origin}/favicon.ico`,
  ];
  return [...new Set(urls)] satisfies string[];
}

/**
 * An image's width in pixels from its header, or null when the format is unknown. For an ICO,
 * the widest image inside it (a favicon.ico often holds 16, 32 and 48).
 */
export function imageWidth(bytes: Uint8Array) {
  const u16le = (at: number) => bytes[at]! | (bytes[at + 1]! << 8);
  const u16be = (at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
  const u32be = (at: number) => ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + u16be(at + 2);
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (bytes.length < 12) return null;
  if (starts([0x89, 0x50, 0x4e, 0x47])) return bytes.length >= 24 ? u32be(16) : null;
  if (starts([0x00, 0x00, 0x01, 0x00])) return icoWidth(bytes, u16le);
  if (starts([0x47, 0x49, 0x46, 0x38])) return u16le(6);
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return webpWidth(bytes, u16le);
  }
  if (starts([0xff, 0xd8])) return jpegWidth(bytes, u16be);
  return null;
}

function icoWidth(bytes: Uint8Array, u16le: (at: number) => number) {
  const count = u16le(4);
  let widest = 0;
  for (let i = 0; i < count && 6 + i * 16 < bytes.length; i++) {
    widest = Math.max(widest, bytes[6 + i * 16] || 256);
  }
  return widest || null;
}

function webpWidth(bytes: Uint8Array, u16le: (at: number) => number) {
  const chunk = String.fromCharCode(...bytes.slice(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30) {
    return 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
  }
  if (chunk === "VP8L" && bytes.length >= 25) return 1 + (u16le(21) & 0x3fff);
  if (chunk === "VP8 " && bytes.length >= 30) return u16le(26) & 0x3fff;
  return null;
}

function jpegWidth(bytes: Uint8Array, u16be: (at: number) => number) {
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return u16be(at + 7);
    }
    at += 2 + u16be(at + 2);
  }
  return null;
}

/** What surrounds the mark at the icon's edge, which decides how the avatar draws it. */
export type LogoEdge =
  | { kind: "transparent" }
  | { kind: "solid"; color: string }
  | { kind: "busy" };

/**
 * Reads the outermost ring of an RGBA bitmap (canvas `getImageData`). Most of the ring see-through
 * is transparent; an opaque ring within a few levels of its mean colour is solid.
 */
export function logoEdge(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number) {
  const ring: number[] = [];
  for (let x = 0; x < width; x++) ring.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) ring.push(y * width, y * width + width - 1);
  const opaque = ring.filter((p) => rgba[p * 4 + 3]! >= 128);
  if (opaque.length < ring.length / 2) return { kind: "transparent" } satisfies LogoEdge;

  const mean = [0, 1, 2].map(
    (c) => opaque.reduce((sum, p) => sum + rgba[p * 4 + c]!, 0) / opaque.length,
  );
  const far = opaque.filter((p) =>
    [0, 1, 2].some((c) => Math.abs(rgba[p * 4 + c]! - mean[c]!) > 24),
  );
  if (far.length > opaque.length * 0.1) return { kind: "busy" } satisfies LogoEdge;
  const hex = mean.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  return { kind: "solid", color: `#${hex}` } satisfies LogoEdge;
}
