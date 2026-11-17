// A sender's avatar picture, or null while it loads and when there is none (initials show).
import { useQuery } from "@tanstack/react-query";
import { senderLogoQuery, type SenderLogo, type SenderLogoFor } from "../lib/sender-logo.ts";

const NONE = { address: "" };

export function useSenderLogo(who: SenderLogoFor | null): SenderLogo | null {
  const { data } = useQuery({ ...senderLogoQuery(who ?? NONE), enabled: !!who });
  return data ?? null;
}
