import type { Address, DisplayNameSpoof } from "../parse.ts";

const INVISIBLE =
  /[\u{AD}\u{61C}\u{115F}\u{1160}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{3164}\u{FEFF}\u{FFA0}]|[\u{34F}\u{17B4}\u{17B5}]/gu;
const ADDRESS_IN_NAME = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+/;
const DOMAIN_TOKEN = /^(?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]{1,62}$/u;
const MAX_CHECKED_NAME = 256;

/** Spoofing hint for a From address: see `DisplayNameSpoof`. */
export const displayNameSpoof: (from: Address | null) => DisplayNameSpoof | null = (from) => {
  if (from === null || from.name === "" || from.name.length > MAX_CHECKED_NAME) return null;
  const hidden = from.name.match(INVISIBLE);
  if (hidden) {
    const codes = [...new Set(hidden)].map(
      (char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
    );
    return { kind: "invisible", claimed: codes.join(" ") };
  }
  const claimedAddress = ADDRESS_IN_NAME.exec(from.name)?.[0].toLowerCase();
  if (claimedAddress !== undefined) {
    return claimedAddress === from.address ? null : { kind: "address", claimed: claimedAddress };
  }
  const senderDomain = domainOf(from.address);
  for (const token of from.name.split(/\s+/)) {
    const domain = token.replace(/^[("'[]+|[)"'\],.:;!?]+$/g, "");
    if (!DOMAIN_TOKEN.test(domain)) continue;
    const claimed = domainOf(`x@${domain}`);
    if (claimed === null || senderDomain === null) continue;
    const related =
      claimed === senderDomain ||
      senderDomain.endsWith(`.${claimed}`) ||
      claimed.endsWith(`.${senderDomain}`);
    if (!related) return { kind: "domain", claimed };
  }
  return null;
};

function domainOf(address: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
}
