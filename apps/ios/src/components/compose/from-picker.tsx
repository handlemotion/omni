import type { Mailbox } from "@omni/client";
import { useState } from "react";
import { IconChevronDown } from "@/components/icons.ts";
import { MailboxAvatar } from "@/components/inbox/mailbox-avatar.tsx";
import { ChoiceRow } from "@/components/shell/mailbox-chooser.tsx";
import { BottomSheet } from "@/components/ui/bottom-sheet.tsx";
import { ChipButton } from "@/components/ui/chip-button.tsx";
import { mailboxName } from "@/lib/mail.ts";
import { useSession } from "@/lib/session.ts";
import { colors, iconSize, space } from "@/theme/tokens.ts";

const SHEET_LEAD = space(9);
const CHEVRON = space(3.5);

/**
 * Who the mail is from, in the composer's header: the mailbox's round avatar and its name (never
 * the raw address), and with more than one to send from, a chevron opening a sheet to choose.
 */
export function FromPicker({
  mailboxes,
  value,
  address,
  onChange,
}: {
  mailboxes: Mailbox[];
  value: string;
  /** The address sent from, named like a shared mailbox while the mailboxes load. */
  address?: string;
  onChange?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const user = useSession().data?.user;
  const you = user?.name || user?.email || "";
  const current = mailboxes.find((m) => m.id === value);
  const name = current
    ? mailboxName(current, you)
    : address
      ? mailboxName({ kind: "shared", address }, you)
      : "";
  const choosable = !!onChange && mailboxes.length > 1;
  return (
    <>
      <ChipButton
        label={name}
        accessibilityLabel={choosable ? `From ${name}, change` : `From ${name}`}
        disabled={!choosable}
        lead={current ? <MailboxAvatar mailbox={current} name={name} size={iconSize.lg} /> : null}
        trailing={
          choosable ? <IconChevronDown size={CHEVRON} color={colors.mutedForeground} /> : null
        }
        onPress={() => setOpen(true)}
      />
      <BottomSheet isOpen={open} onClose={() => setOpen(false)} title="From">
        {mailboxes.map((mailbox) => {
          const label = mailboxName(mailbox, you);
          return (
            <ChoiceRow
              key={mailbox.id}
              lead={<MailboxAvatar mailbox={mailbox} name={label} size={SHEET_LEAD} />}
              name={label}
              detail={mailbox.address}
              chosen={mailbox.id === value}
              onPress={() => {
                setOpen(false);
                onChange?.(mailbox.id);
              }}
            />
          );
        })}
      </BottomSheet>
    </>
  );
}
