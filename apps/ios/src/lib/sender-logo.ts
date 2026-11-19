import { domainOf, isWebmailDomain } from "@omni/mail-core/addresses";
import { WORKSPACE_HEADER } from "@omni/client";
import { useQuery } from "@tanstack/react-query";
import { api, auth } from "./api.ts";
import { keys } from "./query-keys.ts";
import { currentWorkspaceId } from "./workspace-id.ts";

/** Whose logo: a sender's address (their company's mark, or a webmail sender's Gravatar), or a company's domain. */
export type LogoFor = { address: string } | { domain: string };

export interface LogoSource {
  uri: string;
  headers: Record<string, string>;
  /** A Gravatar fills the avatar; a company's mark sits inset on a white tile. */
  photo: boolean;
}

/**
 * Where `who`'s logo is, with the session to fetch it, for `expo-image` (which caches it on disk).
 * The Worker answers 404 when there's none, and the avatar keeps its initial.
 */
export function useLogoSource(who: LogoFor | null) {
  const key = !who
    ? ""
    : "address" in who
      ? who.address.trim().toLowerCase()
      : `@${who.domain.trim().toLowerCase()}`;
  const { data } = useQuery({
    queryKey: keys.senderLogo(key),
    enabled: !!who && key.length > 1,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async () => {
      const byDomain = key.startsWith("@");
      const query = byDomain ? { domain: key.slice(1) } : { address: key };
      const headers: Record<string, string> = {};
      const cookie = await auth.getCookie();
      if (cookie) headers.cookie = cookie;
      const workspace = currentWorkspaceId();
      if (workspace) headers[WORKSPACE_HEADER] = workspace;
      const domain = byDomain ? null : domainOf(key);
      return {
        uri: api["sender-logo"].$url({ query }).toString(),
        headers,
        photo: !!domain && isWebmailDomain(domain),
      } satisfies LogoSource;
    },
  });
  return data ?? null;
}
