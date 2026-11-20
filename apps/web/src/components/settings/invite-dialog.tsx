import { useState } from "react";
import { Label } from "@/components/ui/field";
import { Input, InputGroup } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useWorkspaceMailboxes } from "@/hooks/use-mailbox-members.ts";
import { useInviteWithInbox } from "@/hooks/use-workspace-admin.ts";
import { useMailboxDomains } from "./mailbox-pages";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";
import { type Role, RoleSelect } from "./workspace-pages";

const NO_SHARED = "none";

/**
 * Invites someone with an inbox: their own on a domain on Omni's host, starting as the
 * name they sign in with, and/or a shared inbox to be on. Where the workspace has neither to give,
 * the invitation goes alone and they get theirs after joining.
 */
export function InviteDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const invite = useInviteWithInbox();
  const hosted = useMailboxDomains()?.filter((d) => d.provider === "purelymail") ?? [];
  const shared = (useWorkspaceMailboxes().data?.inboxes ?? []).filter((m) => m.kind === "shared");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [domainId, setDomainId] = useState<string | null>(null);
  const [edited, setEdited] = useState<string | null>(null);
  const [sharedId, setSharedId] = useState(NO_SHARED);
  const address = email.trim();
  const domain = hosted.find((d) => d.id === domainId) ?? hosted[0];
  const localPart = (edited ?? address.split("@")[0] ?? "").trim();
  const sharedInboxIds = sharedId === NO_SHARED ? [] : [sharedId];
  const canGive = !!domain || shared.length > 0;
  const gives = (!!domain && localPart !== "") || sharedInboxIds.length > 0;
  const reset = () => {
    setEmail("");
    setRole("member");
    setEdited(null);
    setSharedId(NO_SHARED);
  };
  return (
    <SettingsFormDialog
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      title="Invite member"
      description="They get an email with a link to join this workspace."
      action="Invite"
      disabled={!address || (canGive && !gives)}
      saving={invite.isPending}
      onSubmit={() =>
        invite.mutate(
          {
            email: address,
            role,
            ...(domain && localPart ? { inbox: { domainId: domain.id, localPart } } : {}),
            sharedInboxIds,
          },
          {
            onSuccess: () => {
              reset();
              onClose();
              appToast.success(`Invitation sent to ${address}`);
            },
            onError: (error) => appToast.error(error.message || "The invitation was not sent."),
          },
        )
      }
    >
      <TextField type="email" isRequired autoFocus value={email} onChange={setEmail}>
        <Label>Email</Label>
        <Input placeholder="name@company.com" autoComplete="off" />
      </TextField>
      <RoleSelect value={role} onChange={setRole} />
      {hosted.length > 1 && (
        <Select value={domain?.id ?? null} onChange={(next) => next && setDomainId(String(next))}>
          <Label>Domain</Label>
          <SelectTrigger />
          <SelectContent items={hosted}>
            {(d) => (
              <SelectItem id={d.id} textValue={d.domain}>
                {d.domain}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
      {domain && (
        <TextField value={localPart} onChange={setEdited}>
          <Label>Inbox</Label>
          <InputGroup className="[--input-gutter-end:--spacing(4)]">
            <Input placeholder="name" autoComplete="off" />
            <span data-slot="text" className="text-sm text-muted-foreground">
              @{domain.domain}
            </span>
          </InputGroup>
        </TextField>
      )}
      {shared.length > 0 && (
        <Select value={sharedId} onChange={(next) => setSharedId(next ? String(next) : NO_SHARED)}>
          <Label>Shared inbox</Label>
          <SelectTrigger />
          <SelectContent items={[{ id: NO_SHARED, address: "None" }, ...shared]}>
            {(m) => (
              <SelectItem id={m.id} textValue={m.address}>
                {m.address}
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      )}
    </SettingsFormDialog>
  );
}
