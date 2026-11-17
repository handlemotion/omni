import type { ComponentProps } from "react";
import { Avatar } from "@/components/ui/avatar";
import { useSenderLogo } from "@/hooks/use-sender-logo";
import type { SenderLogoFor } from "@/lib/sender-logo";

/**
 * A sender's avatar: their company's logo inset on its own background colour, a webmail
 * sender's Gravatar, or their initial until one loads and when there is none.
 */
export function SenderAvatar({
  who,
  name,
  ...props
}: Omit<ComponentProps<typeof Avatar>, "src" | "initials" | "logoTile"> & {
  who: SenderLogoFor | null;
  name: string;
}) {
  const logo = useSenderLogo(who);
  const initials = name.trim().slice(0, 1).toUpperCase() || "?";
  if (!logo) return <Avatar {...props} initials={initials} />;
  const { edge } = logo;
  const logoTile =
    edge.kind === "solid" ? edge.color : edge.kind === "transparent" ? "light" : undefined;
  return <Avatar {...props} src={logo.src} logoTile={logoTile} />;
}

/** `who` for an address that may be missing. */
export const byAddress = (address: string | null | undefined) => {
  const result: SenderLogoFor | null = address ? { address } : null;
  return result;
};
