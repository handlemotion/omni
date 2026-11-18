import type { ComponentProps } from "react";
import { Avatar } from "@/components/ui/avatar";
import { useMember } from "@/hooks/use-session.ts";
import { pictureUrl } from "@/lib/urls.ts";
import { SenderAvatar } from "./sender-avatar";

/**
 * A mailbox's own avatar. A personal inbox shows its account's picture (Google's photo), your
 * profile picture on your sign-in address, else its address's Gravatar or logo; a shared one,
 * and any without a picture, its name's initial.
 */
export function MailboxAvatar({
  mailbox,
  name,
  ...props
}: Omit<ComponentProps<typeof Avatar>, "src" | "initials" | "logoTile"> & {
  mailbox: { address: string; kind: "personal" | "shared"; picture?: string | null };
  name: string;
}) {
  const { user } = useMember();
  const initials = name.trim().slice(0, 1).toUpperCase() || undefined;
  if (mailbox.kind === "shared") return <Avatar {...props} initials={initials} />;
  const own =
    mailbox.picture ??
    (mailbox.address.toLowerCase() === user.email.toLowerCase() ? user.image : null);
  if (own) return <Avatar {...props} src={pictureUrl(own)} initials={initials} />;
  return <SenderAvatar {...props} who={{ address: mailbox.address }} name={name} />;
}
