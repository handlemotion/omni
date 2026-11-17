import { useState } from "react";
import { Skeleton } from "skullet/react";
import { IconForward, IconMail, IconPencil, IconX } from "@/components/icons/central";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useClearForwarding, useForwarding, useSetForwarding } from "@/hooks/use-forwarding.ts";
import type { Forwarding, ForwardScope } from "@/lib/types.ts";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";

const SCOPES: { id: ForwardScope; label: string }[] = [
  { id: "conversations", label: "Conversations you're in" },
  { id: "sent", label: "Mail you send" },
  { id: "all", label: "Everything" },
];

const failed = (error: Error) => appToast.error(error.message);

export function ForwardingPage() {
  const forwarding = useForwarding();
  const clear = useClearForwarding();
  const [editing, setEditing] = useState<Forwarding | null>(null);

  return (
    <SettingsSections>
      <SettingsSection title="Forwarding address">
        <Skeleton
          id="settings-forwarding"
          data={forwarding.data?.mailboxes ?? null}
          sample={[SAMPLE]}
          label="Loading forwarding"
        >
          {(list) =>
            list.length === 0 ? (
              <SettingsEmptyState title="No personal mailboxes" />
            ) : (
              <SettingsGroup>
                {list.map((mailbox) => (
                  <SettingsRow
                    key={mailbox.mailboxId}
                    icon={IconMail}
                    label={mailbox.address}
                    description={mailbox.forwardAddress ?? "Off"}
                    badge={<ForwardingBadge mailbox={mailbox} />}
                    control={
                      <SettingsRowMenu
                        label={`Options for ${mailbox.address}`}
                        items={[
                          {
                            icon: mailbox.forwardAddress ? IconPencil : IconForward,
                            label: mailbox.forwardAddress ? "Edit" : "Set up",
                            onAction: () => setEditing(mailbox),
                          },
                          ...(mailbox.forwardAddress
                            ? [
                                {
                                  icon: IconX,
                                  label: "Turn off",
                                  danger: true,
                                  onAction: () =>
                                    clear.mutate(mailbox.mailboxId, { onError: failed }),
                                },
                              ]
                            : []),
                        ]}
                      />
                    }
                  />
                ))}
              </SettingsGroup>
            )
          }
        </Skeleton>
      </SettingsSection>
      {editing && <ForwardingDialog mailbox={editing} onClose={() => setEditing(null)} />}
    </SettingsSections>
  );
}

const SAMPLE: Forwarding = {
  mailboxId: "sample",
  orgId: "sample",
  address: "you@example.com",
  forwardAddress: null,
  scope: "conversations",
  lastForwardedAt: null,
  lastError: null,
};

function ForwardingBadge({ mailbox }: { mailbox: Forwarding }) {
  if (!mailbox.forwardAddress) return null;
  return mailbox.lastError ? (
    <Badge intent="danger">Failing</Badge>
  ) : (
    <Badge intent="success">In sync</Badge>
  );
}

function ForwardingDialog({ mailbox, onClose }: { mailbox: Forwarding; onClose: () => void }) {
  const save = useSetForwarding();
  const [address, setAddress] = useState(mailbox.forwardAddress ?? "");
  const [scope, setScope] = useState<ForwardScope>(mailbox.scope);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title={mailbox.address}
      action="Save"
      disabled={!address.trim()}
      saving={save.isPending}
      onSubmit={() =>
        save.mutate(
          { mailboxId: mailbox.mailboxId, address: address.trim(), scope },
          { onSuccess: onClose, onError: failed },
        )
      }
    >
      <TextField type="email" isRequired autoFocus value={address} onChange={setAddress}>
        <Label>Forwarding address</Label>
        <Input placeholder="workspace@attio.email" autoComplete="off" />
      </TextField>
      <Select
        value={scope}
        onChange={(next) => {
          const option = SCOPES.find((s) => s.id === next);
          if (option) setScope(option.id);
        }}
      >
        <Label>Forward</Label>
        <SelectTrigger />
        <SelectContent items={SCOPES}>
          {(option) => (
            <SelectItem id={option.id} textValue={option.label}>
              {option.label}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </SettingsFormDialog>
  );
}
