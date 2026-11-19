import { Avatar } from "@/components/ui/avatar.tsx";
import { usePictureSource } from "@/lib/picture.ts";
import { useSession } from "@/lib/session.ts";

/** The fields a mailbox's avatar reads. */
export interface MailboxFace {
  address: string;
  kind: "personal" | "shared";
  picture?: string | null;
}

/**
 * A mailbox's own avatar, as the web's: a personal inbox shows its account's picture, your
 * profile picture on your sign-in address, else its address's logo; a shared one its initial.
 * Whatever it shows fills the avatar: only a sender's mark is inset on a tile.
 */
export function MailboxAvatar({
  mailbox,
  name,
  size,
}: {
  mailbox: MailboxFace;
  name: string;
  size: number;
}) {
  const user = useSession().data?.user;
  const personal = mailbox.kind === "personal";
  const yours = !!user && mailbox.address.toLowerCase() === user.email.toLowerCase();
  const own = personal ? (mailbox.picture ?? (yours ? user?.image : null)) : null;
  const photo = usePictureSource(own);
  return (
    <Avatar
      name={name}
      size={size}
      fill
      photo={photo}
      logo={personal && !own ? { address: mailbox.address } : null}
    />
  );
}
