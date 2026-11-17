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

const loadSenderLogo: (who: SenderLogoFor) => Promise<SenderLogo | null> = async (who) => {
  const src = api["sender-logo"].$url({ query: who }).toString();
  const image = new Image();
  image.src = src;
  try {
    await image.decode();
  } catch {
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
};
