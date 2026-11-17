import { useQuery } from "@tanstack/react-query";
import { senderLogoQuery, type SenderLogo, type SenderLogoFor } from "../lib/sender-logo.ts";

const NONE = { address: "" };

export const useSenderLogo: (who: SenderLogoFor | null) => SenderLogo | null = (who) => {
  const { data } = useQuery({ ...senderLogoQuery(who ?? NONE), enabled: !!who });
  return data ?? null;
};
