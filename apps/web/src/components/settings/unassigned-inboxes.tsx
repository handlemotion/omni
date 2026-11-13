// Inboxes former members left behind (ADR 0026), for owners and admins on People: nobody can open
// them and they don't sync until one is given to someone, made shared, or removed.
import { IconTrash, IconUserRound, IconUsers } from "@/components/icons/central";
import { useState } from "react";
import { appToast } from "@/components/ui/toast";
import { useWorkspaceMailboxes } from "@/hooks/use-mailbox-members.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { useGiveInbox, useRemoveInbox, useShareInbox } from "@/hooks/use-workspace-admin.ts";
import type { OrgMailbox } from "@/lib/types.ts";
import { SettingsGroup, SettingsSection } from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsConfirmDialog, SettingsFormDialog } from "./kit/settings-stacked-dialog";
import { PersonSelect } from "./mailbox-pages";

type Person = { id: string; name: string };
type Pending = { kind: "give" | "share" | "remove"; inbox: OrgMailbox };

/** Nothing when there are none. */
export function UnassignedInboxesSection() {
  const members = useMembers().data?.members ?? [];
  const people = members.map((m) => ({ id: m.id, name: m.user.name || m.user.email }));
  const inboxes = useWorkspaceMailboxes().data?.inboxes.filter((m) => m.orphaned);
  const [pending, setPending] = useState<Pending | null>(null);
  const close = () => setPending(null);
  if (!inboxes || inboxes.length === 0) return null;
  return (
    <SettingsSection title="Unassigned">
      <SettingsGroup>
        {inboxes.map((inbox) => (
          <SettingsRow
            key={inbox.id}
            label={inbox.address}
            control={
              <SettingsRowMenu
                label={`Actions for ${inbox.address}`}
                items={[
                  {
                    icon: IconUserRound,
                    label: "Give to",
                    onAction: () => setPending({ kind: "give", inbox }),
                  },
                  {
                    icon: IconUsers,
                    label: "Make shared",
                    onAction: () => setPending({ kind: "share", inbox }),
                  },
                  {
                    icon: IconTrash,
                    label: "Remove inbox",
                    danger: true,
                    onAction: () => setPending({ kind: "remove", inbox }),
                  },
                ]}
              />
            }
          />
        ))}
      </SettingsGroup>
      {pending && pending.kind !== "remove" && (
        <AssignInboxDialog
          key={pending.inbox.id}
          inbox={pending.inbox}
          shared={pending.kind === "share"}
          people={people}
          onClose={close}
        />
      )}
      <RemoveInboxDialog
        inbox={pending?.kind === "remove" ? pending.inbox : undefined}
        onClose={close}
      />
    </SettingsSection>
  );
}

/** Gives a former member's inbox to one person, or makes it a shared inbox they are on. */
function AssignInboxDialog(props: {
  inbox: OrgMailbox;
  shared: boolean;
  people: Person[];
  onClose: () => void;
}) {
  const give = useGiveInbox();
  const share = useShareInbox();
  const [picked, setPicked] = useState<string | null>(null);
  const done = {
    onSuccess: props.onClose,
    onError: (error: Error) =>
      appToast.error(error.message || `${props.inbox.address} could not be changed.`),
  };
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={props.shared ? `Make ${props.inbox.address} shared` : `Give ${props.inbox.address}`}
      action={props.shared ? "Make shared" : "Give"}
      disabled={!picked}
      saving={give.isPending || share.isPending}
      onSubmit={() => {
        if (!picked) return;
        if (props.shared) share.mutate({ mailboxId: props.inbox.id, memberIds: [picked] }, done);
        else give.mutate({ mailboxId: props.inbox.id, memberId: picked }, done);
      }}
    >
      <PersonSelect people={props.people} value={picked} onChange={setPicked} />
    </SettingsFormDialog>
  );
}

function RemoveInboxDialog(props: { inbox: OrgMailbox | undefined; onClose: () => void }) {
  const remove = useRemoveInbox();
  // Kept while the dialog animates out, so its title doesn't change under it.
  const [shown, setShown] = useState(props.inbox);
  if (props.inbox && props.inbox !== shown) setShown(props.inbox);
  return (
    <SettingsConfirmDialog
      isOpen={!!props.inbox}
      onOpenChange={(open) => !open && props.onClose()}
      title={`Remove ${shown?.address ?? "inbox"}?`}
      description="Omni stops syncing it. Its mail stays with your mail host."
      action="Remove inbox"
      saving={remove.isPending}
      onConfirm={() =>
        shown &&
        remove.mutate(shown.id, {
          onSuccess: props.onClose,
          onError: (error) =>
            appToast.error(error.message || `${shown.address} could not be removed.`),
        })
      }
    />
  );
}
