// A sender's avatar picture: their company's logo, or a webmail sender's Gravatar, through the
// Worker (which caches it for a week). The image is decoded once here and its edge read, so the
// avatar knows whether to inset it on a tile of its own colour; the browser's HTTP cache serves
// the bytes again when the avatar draws it.
import { domainOf, isWebmailDomain } from "@omni/mail-core/addresses";
import { logoEdge, type LogoEdge } from "@omni/mail-core/sender-logo";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys } from "./query-keys.ts";

export type SenderLogoFor = { address: string } | { domain: string };

export interface SenderLogo {
  src: string;
  /** `photo` (a Gravatar) fills the avatar; a logo's edge decides its tile. */
  edge: LogoEdge | { kind: "photo" };
}

/** Side of the bitmap the edge is read from: enough to see a tile's colour, cheap to scan. */
const SAMPLE = 32;

export function senderLogoQuery(who: SenderLogoFor) {
  const key = "address" in who ? who.address.trim().toLowerCase() : `@${who.domain.toLowerCase()}`;
  return queryOptions({
    queryKey: keys.senderLogo(key),
    queryFn: () => loadSenderLogo(who),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
}

async function loadSenderLogo(who: SenderLogoFor): Promise<SenderLogo | null> {
  const src = api["sender-logo"].$url({ query: who }).toString();
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
    // 404 (no logo) or unreadable: the avatar keeps its initials.
    return null;
  }
  const domain = "address" in who ? domainOf(who.address) : null;
  if (domain && isWebmailDomain(domain)) return { src, edge: { kind: "photo" } };
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SAMPLE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return { src, edge: { kind: "busy" } };
  context.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  return { src, edge: logoEdge(context.getImageData(0, 0, SAMPLE, SAMPLE).data, SAMPLE, SAMPLE) };
}
