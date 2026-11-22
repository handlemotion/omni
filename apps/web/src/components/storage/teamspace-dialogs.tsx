import { useNavigate } from "@tanstack/react-router";
import { Skeleton, SkeletonBox } from "skullet/react";
import { ListFailed } from "@/components/inbox/thread-list";
import { useMemo, useState, type FormEvent } from "react";
import { IconTrash, IconUserCog, IconUserMinus } from "@/components/icons/central";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  MultipleSelect,
  MultipleSelectContent,
  MultipleSelectItem,
} from "@/components/ui/multiple-select";
import { Switch, SwitchField } from "@/components/ui/switch";
import { TextField } from "@/components/ui/text-field";
import { useMembers } from "@/hooks/use-organization.ts";
import {
  useCreateTeamspace,
  useDeleteTeamspace,
  useJoinTeamspace,
  usePutTeamspaceMember,
  useTeamspaceMembers,
  useTeamspaces,
  useUpdateTeamspace,
} from "@/hooks/use-storage.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import type { StorageTeamspace, StorageTeamspaceMember } from "@/lib/storage-teamspaces.ts";
import { storageErrorToast } from "./storage-errors.ts";
import { drivePath } from "./storage-nav.tsx";

function useWorkspacePeople() {
  const query = useMembers();
  const members = query.data?.members;
  const people = useMemo(
    () =>
      (members ?? []).map((m) => ({
        id: m.id,
        name: m.user.name || m.user.email,
        image: m.user.image ?? null,
      })),
    [members],
  );
  return { people, query };
}

function PeopleField(props: {
  label: string;
  value: string[];
  onChange: (memberIds: string[]) => void;
  exclude: Set<string>;
}) {
  const { people: everyone, query } = useWorkspacePeople();
  const people = everyone.filter((person) => !props.exclude.has(person.id));
  if (query.isPending) {
    return (
      <Skeleton loading label="Loading people" skeleton={<SkeletonBox width="100%" height={36} />}>
        {null}
      </Skeleton>
    );
  }
  if (query.isError) return <ListFailed retry={() => void query.refetch()} />;
  return (
    <MultipleSelect
      aria-label={props.label}
      placeholder="Nobody"
      value={props.value}
      onChange={(keys) => props.onChange(keys.map(String))}
    >
      <Label>{props.label}</Label>
      <MultipleSelectContent items={people}>
        {(person) => (
          <MultipleSelectItem id={person.id} textValue={person.name}>
            {person.name}
          </MultipleSelectItem>
        )}
      </MultipleSelectContent>
    </MultipleSelect>
  );
}

function PrivateSwitch(props: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <Label htmlFor="teamspace-private">Private</Label>
      <SwitchField id="teamspace-private" isSelected={props.value} onChange={props.onChange}>
        <Switch />
      </SwitchField>
    </div>
  );
}

/** Makes a teamspace owned by the member, then opens it. */
export function NewTeamspaceDialog(props: { selfId: string | undefined; onClose: () => void }) {
  const create = useCreateTeamspace();
  const navigate = useNavigate();
  const { href } = useWorkspacePaths();
  const [name, setName] = useState("");
  const [closed, setClosed] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const exclude = useMemo(() => new Set(props.selfId ? [props.selfId] : []), [props.selfId]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate(
      { name: name.trim(), private: closed, memberIds: people },
      {
        onSuccess: ({ teamspace }) => {
          props.onClose();
          void navigate({ href: href(drivePath({ teamspaceId: teamspace.id })) });
        },
        onError: (error) => storageErrorToast(error, "The space was not made"),
      },
    );
  };
  return (
    <Dialog size="md" isOpen onOpenChange={(open) => !open && !create.isPending && props.onClose()}>
      <DialogHeader>
        <DialogTitle>New space</DialogTitle>
      </DialogHeader>
      <form className="contents" onSubmit={submit}>
        <DialogBody className="gap-4">
          <TextField aria-label="Name" value={name} onChange={setName} autoFocus>
            <Label>Name</Label>
            <Input autoComplete="off" />
          </TextField>
          <PeopleField label="People" value={people} onChange={setPeople} exclude={exclude} />
          <PrivateSwitch value={closed} onChange={setClosed} />
        </DialogBody>
        <DialogFooter>
          <DialogClose intent="outline" isDisabled={create.isPending}>
            Cancel
          </DialogClose>
          <Button type="submit" isDisabled={!name.trim()} isPending={create.isPending}>
            Create
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}

/** The open teamspaces the member is not in, to join. */
export function BrowseTeamspacesDialog(props: { onClose: () => void }) {
  const { teamspaces } = useTeamspaces();
  const join = useJoinTeamspace();
  const navigate = useNavigate();
  const { href } = useWorkspacePaths();
  const open = teamspaces.filter((teamspace) => teamspace.role === null);
  return (
    <Dialog size="md" isOpen onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogHeader>
        <DialogTitle>Spaces</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <ul className="flex flex-col">
          {open.map((teamspace) => (
            <li key={teamspace.id} className="flex h-10 items-center gap-2.5">
              <span className="min-w-0 flex-1 truncate">{teamspace.name}</span>
              <Button
                intent="outline"
                size="sm"
                isPending={join.isPending && join.variables === teamspace.id}
                onPress={() =>
                  join.mutate(teamspace.id, {
                    onSuccess: () => {
                      props.onClose();
                      void navigate({ href: href(drivePath({ teamspaceId: teamspace.id })) });
                    },
                    onError: (error) => storageErrorToast(error, "You did not join it"),
                  })
                }
              >
                Join
              </Button>
            </li>
          ))}
        </ul>
      </DialogBody>
      <DialogFooter>
        <DialogClose intent="outline">Done</DialogClose>
      </DialogFooter>
    </Dialog>
  );
}

/** A teamspace's name, whether it is private, and who is in it; whoever manages it changes them. */
export function TeamspaceSettingsDialog(props: {
  teamspace: StorageTeamspace;
  onClose: () => void;
}) {
  const { teamspace } = props;
  const update = useUpdateTeamspace();
  const [name, setName] = useState(teamspace.name);
  const [closed, setClosed] = useState(teamspace.private);
  const changed = name.trim() !== teamspace.name || closed !== teamspace.private;
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!changed || !name.trim()) return;
    update.mutate(
      { id: teamspace.id, name: name.trim(), private: closed },
      {
        onSuccess: props.onClose,
        onError: (error) => storageErrorToast(error, "The space was not changed"),
      },
    );
  };
  return (
    <Dialog size="md" isOpen onOpenChange={(open) => !open && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">{teamspace.name}</DialogTitle>
      </DialogHeader>
      <form className="contents" onSubmit={save}>
        <DialogBody className="gap-4">
          {teamspace.manage && (
            <>
              <TextField aria-label="Name" value={name} onChange={setName}>
                <Label>Name</Label>
                <Input autoComplete="off" />
              </TextField>
              <PrivateSwitch value={closed} onChange={setClosed} />
            </>
          )}
          <Members teamspace={teamspace} />
        </DialogBody>
        <DialogFooter>
          {teamspace.manage && <DeleteTeamspace teamspace={teamspace} onDone={props.onClose} />}
          <span className="flex-1" />
          {teamspace.manage ? (
            <Button
              type="submit"
              isDisabled={!changed || !name.trim()}
              isPending={update.isPending}
            >
              Save
            </Button>
          ) : (
            <DialogClose intent="outline">Done</DialogClose>
          )}
        </DialogFooter>
      </form>
    </Dialog>
  );
}

function Members(props: { teamspace: StorageTeamspace }) {
  const { teamspace } = props;
  const listed = useTeamspaceMembers(teamspace.id);
  const put = usePutTeamspaceMember();
  const [adding, setAdding] = useState<string[]>([]);
  const members = listed.data ?? [];
  const inIt = useMemo(() => new Set(members.map((m) => m.memberId)), [members]);
  const change = (memberId: string, role: StorageTeamspaceMember["role"] | null) =>
    put.mutate(
      { id: teamspace.id, memberId, role },
      { onError: (error) => storageErrorToast(error, "Its people were not changed") },
    );
  if (listed.isPending) {
    return (
      <Skeleton loading label="Loading people" skeleton={<MembersBones />}>
        {null}
      </Skeleton>
    );
  }
  if (listed.isError) return <ListFailed retry={() => void listed.refetch()} />;
  return (
    <div className="flex flex-col gap-2">
      {teamspace.manage && (
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <PeopleField label="Add people" value={adding} onChange={setAdding} exclude={inIt} />
          </div>
          <Button
            intent="outline"
            isDisabled={adding.length === 0}
            onPress={() => {
              for (const memberId of adding) change(memberId, "member");
              setAdding([]);
            }}
          >
            Add
          </Button>
        </div>
      )}
      <ul className="flex flex-col">
        {members.map((member) => (
          <li key={member.memberId} className="flex h-10 items-center gap-2.5">
            <Avatar size="xs" src={member.image} initials={member.name.slice(0, 1).toUpperCase()} />
            <span className="min-w-0 flex-1 truncate">{member.name}</span>
            <span className="text-muted-foreground">
              {member.role === "owner" ? "Owner" : "Member"}
            </span>
            {teamspace.manage && (
              <SettingsRowMenu
                label={`Actions for ${member.name}`}
                items={memberMenu(member, change)}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function MembersBones() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-2.5">
          <SkeletonBox width={24} height={24} radius="9999px" />
          <SkeletonBox width={`${30 + i * 12}%`} height={10} />
        </div>
      ))}
    </div>
  );
}

const memberMenu = (
  member: StorageTeamspaceMember,
  change: (memberId: string, role: StorageTeamspaceMember["role"] | null) => void,
) =>
  [
    {
      icon: IconUserCog,
      label: member.role === "owner" ? "Make member" : "Make owner",
      onAction: () => change(member.memberId, member.role === "owner" ? "member" : "owner"),
    },
    {
      icon: IconUserMinus,
      label: "Remove",
      danger: true,
      onAction: () => change(member.memberId, null),
    },
  ] satisfies SettingsRowMenuItem[];

function DeleteTeamspace(props: { teamspace: StorageTeamspace; onDone: () => void }) {
  const remove = useDeleteTeamspace();
  const navigate = useNavigate();
  const { href } = useWorkspacePaths();
  return (
    <Button
      intent="danger"
      isPending={remove.isPending}
      onPress={() =>
        remove.mutate(props.teamspace.id, {
          onSuccess: () => {
            props.onDone();
            void navigate({ href: href("/files") });
          },
          onError: (error) => storageErrorToast(error, "The space was not deleted"),
        })
      }
    >
      <IconTrash data-slot="icon" />
      Delete space
    </Button>
  );
}
