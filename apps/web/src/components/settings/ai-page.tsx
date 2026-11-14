// AI (ADR 0033): what each person in the workspace handles, which triage reads to hand a shared
// inbox's customer messages to the right teammate, and what each shared inbox's tags are for.
// Owners and admins only, like People. Tags themselves are added and renamed on Helpdesk.
import { IconPencil, IconTrash } from "@/components/icons/central";
import { useId, useState } from "react";
import { Skeleton } from "skullet/react";
import { Label } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { appToast } from "@/components/ui/toast";
import { useAiSettings, useSetRole, useSetTagDescription } from "@/hooks/use-ai-settings.ts";
import { useMember } from "@/hooks/use-session.ts";
import type { AiSettings } from "@/lib/ai-settings.ts";
import { PersonAvatar } from "./account-pages";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";

/** The API's cap on a role or a tag's description. */
const MAX_DESCRIPTION = 500;

type Person = AiSettings["members"][number];
type Inbox = AiSettings["sharedInboxes"][number];
type Tag = Inbox["tags"][number];

type Editing = { kind: "role"; person: Person } | { kind: "tag"; inbox: Inbox; tag: Tag } | null;

// Skeleton stand-ins, the shape of what loads.
const SAMPLE = {
  members: ["Ana Ortiz", "Bo Lindqvist", "Cy Mensah"].map((name, i) => ({
    id: `sample-${i}`,
    user: { id: `sample-${i}`, name, email: "", image: null },
    sharedInboxes: [],
    roleDescription: i === 0 ? "Billing, invoices and refunds" : null,
  })),
  sharedInboxes: [
    {
      id: "sample-inbox",
      address: "support@example.com",
      tags: ["Billing", "Bug", "Refund"].map((name, i) => ({
        id: `sample-tag-${i}`,
        name,
        color: null,
        description: null,
      })),
    },
  ],
} as unknown as AiSettings;

export function AiPage() {
  const settings = useAiSettings();
  const [editing, setEditing] = useState<Editing>(null);
  const close = () => setEditing(null);

  return (
    <Skeleton id="settings-ai" data={settings.data} sample={SAMPLE} label="Loading AI settings">
      {(data) => (
        <SettingsSections>
          <SettingsSection title="Roles">
            <SettingsGroup>
              {data.members.map((person) => (
                <PersonRow
                  key={person.id}
                  person={person}
                  onEdit={() => setEditing({ kind: "role", person })}
                />
              ))}
            </SettingsGroup>
          </SettingsSection>

          {data.sharedInboxes.map((inbox) => (
            <SettingsSection key={inbox.id} title={inbox.address}>
              {inbox.tags.length === 0 ? (
                <SettingsEmptyState title="No tags" />
              ) : (
                <SettingsGroup>
                  {inbox.tags.map((tag) => (
                    <TagRow
                      key={tag.id}
                      inbox={inbox}
                      tag={tag}
                      onEdit={() => setEditing({ kind: "tag", inbox, tag })}
                    />
                  ))}
                </SettingsGroup>
              )}
            </SettingsSection>
          ))}

          {editing?.kind === "role" && <RoleDialog person={editing.person} onClose={close} />}
          {editing?.kind === "tag" && (
            <TagDialog inbox={editing.inbox} tag={editing.tag} onClose={close} />
          )}
        </SettingsSections>
      )}
    </Skeleton>
  );
}

function PersonRow({ person, onEdit }: { person: Person; onEdit: () => void }) {
  const { member } = useMember();
  const setRole = useSetRole();
  const name = person.user.name || person.user.email;
  return (
    <SettingsRow
      avatar={<PersonAvatar name={name} image={person.user.image} />}
      label={name}
      hint={person.id === member.id ? "you" : undefined}
      description={person.roleDescription ?? undefined}
      control={
        <SettingsRowMenu
          label={`Actions for ${name}`}
          items={[
            { icon: IconPencil, label: "Edit role", onAction: onEdit },
            ...(person.roleDescription
              ? [
                  {
                    icon: IconTrash,
                    label: "Clear role",
                    danger: true,
                    onAction: () =>
                      setRole.mutate(
                        { memberId: person.id, description: "" },
                        { onError: () => appToast.error(`${name}'s role was not cleared.`) },
                      ),
                  },
                ]
              : []),
          ]}
        />
      }
    />
  );
}

function TagRow({ inbox, tag, onEdit }: { inbox: Inbox; tag: Tag; onEdit: () => void }) {
  const setDescription = useSetTagDescription();
  return (
    <SettingsRow
      label={tag.name}
      description={tag.description ?? undefined}
      control={
        <SettingsRowMenu
          label={`Actions for ${tag.name}`}
          items={[
            { icon: IconPencil, label: "Edit description", onAction: onEdit },
            ...(tag.description
              ? [
                  {
                    icon: IconTrash,
                    label: "Clear description",
                    danger: true,
                    onAction: () =>
                      setDescription.mutate(
                        { mailboxId: inbox.id, tagId: tag.id, description: "" },
                        {
                          onError: () =>
                            appToast.error(`${tag.name}'s description was not cleared.`),
                        },
                      ),
                  },
                ]
              : []),
          ]}
        />
      }
    />
  );
}

/** One long text over settings: a label and a writing area, Cancel and Save. */
function DescriptionDialog(props: {
  title: string;
  label: string;
  value: string | null;
  saving: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [text, setText] = useState(props.value ?? "");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={props.title}
      action="Save"
      disabled={text.trim() === (props.value ?? "")}
      saving={props.saving}
      onSubmit={() => props.onSave(text.trim())}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>{props.label}</Label>
        <Textarea
          id={id}
          autoFocus
          maxLength={MAX_DESCRIPTION}
          value={text}
          onChange={(event) => setText(event.target.value)}
          className="max-h-60 min-h-24 resize-none"
        />
      </div>
    </SettingsFormDialog>
  );
}

function RoleDialog({ person, onClose }: { person: Person; onClose: () => void }) {
  const setRole = useSetRole();
  const name = person.user.name || person.user.email;
  return (
    <DescriptionDialog
      title={name}
      label="Role"
      value={person.roleDescription}
      saving={setRole.isPending}
      onClose={onClose}
      onSave={(description) =>
        setRole.mutate(
          { memberId: person.id, description },
          { onSuccess: onClose, onError: () => appToast.error(`${name}'s role was not saved.`) },
        )
      }
    />
  );
}

function TagDialog({ inbox, tag, onClose }: { inbox: Inbox; tag: Tag; onClose: () => void }) {
  const setDescription = useSetTagDescription();
  return (
    <DescriptionDialog
      title={tag.name}
      label="Description"
      value={tag.description}
      saving={setDescription.isPending}
      onClose={onClose}
      onSave={(description) =>
        setDescription.mutate(
          { mailboxId: inbox.id, tagId: tag.id, description },
          {
            onSuccess: onClose,
            onError: () => appToast.error(`${tag.name}'s description was not saved.`),
          },
        )
      }
    />
  );
}
