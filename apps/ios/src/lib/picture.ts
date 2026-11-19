import { useQuery } from "@tanstack/react-query";
import { api } from "./api.ts";
import { config } from "./config.ts";
import { storageHeaders } from "./drive.ts";
import { keys } from "./query-keys.ts";
import type { LogoSource } from "./sender-logo.ts";

/**
 * Where an uploaded picture (a workspace's logo, `/api/pictures/…`) or an outside image is, with
 * the session to fetch it, as a photo that fills its avatar. Null while there is none.
 */
export function usePictureSource(src: string | null | undefined) {
  const { data: headers } = useQuery({
    queryKey: keys.storageHeaders(),
    queryFn: () => storageHeaders(),
    staleTime: 60_000,
    enabled: !!src,
  });
  if (!src || !headers) return null;
  const uri = /^https?:\/\//i.test(src)
    ? api["image-proxy"].$url({ query: { url: src } }).toString()
    : new URL(src, config.apiUrl).toString();
  return { uri, headers, photo: true } satisfies LogoSource;
}
