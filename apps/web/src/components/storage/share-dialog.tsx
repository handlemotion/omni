// Sharing a file or folder (ADR 0034 decision 4), after Figma's and Gamma's share dialogs: add
// someone by address with a role, then who has access, then general access and the link.
//
// Geometry: three groups 20px apart in the dialog body; within a group, rows 8px apart. A person
// is a 40px row: a 24px avatar, the address 10px after it (with the folder they come through
// under it when the access is inherited), the role at the end.
import { useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconCheck,
  IconCopy,
  IconFolder,
  IconGlobe,
  IconLock,
  IconX,
} from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, InputGroup } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { useClipboard } from "@/hooks/use-clipboard.ts";
import {
  usePutStoragePerson,
  useRemoveStoragePerson,
  useSetStorageLink,
  useStorageSharing,
} from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import {
  shareUrl,
  type StorageGrantRole,
  type StorageLinkAccess,
  type StorageSharing,
} from "@/lib/storage-sharing.ts";
import { storageErrorToast } from "./storage-errors.ts";

const ROLES: { id: StorageGrantRole; label: string }[] = [
  { id: "viewer", label: "Viewer" },
  { id: "commenter", label: "Commenter" },
  { id: "editor", label: "Editor" },
];
const ACCESS: { id: StorageLinkAccess; label: string }[] = [
  { id: "restricted", label: "Restricted" },
  { id: "anyone", label: "Anyone with the link" },
];
const roleLabel = (role: StorageGrantRole) => ROLES.find((r) => r.id === role)?.label ?? role;

export function ShareDialog(props: { node: StorageNode; onClose: () => void }) {
  const sharing = useStorageSharing(props.node.id);
  return (
    <Dialog size="md" isOpen onOpenChange={(open) => !open && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">Share “{props.node.name}”</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-5">
        <AddPerson nodeId={props.node.id} />
        <Skeleton
          id="storage-sharing"
          data={sharing.data?.sharing}
          sample={SAMPLE}
          label="Loading sharing"
        >
          {(state) => (
            // Its own column: the loading wrapper would otherwise take the body's gap.
            <div className="flex flex-col gap-5">
              <People sharing={state} />
              <GeneralAccess sharing={state} />
            </div>
          )}
        </Skeleton>
      </DialogBody>
    </Dialog>
  );
}

const SAMPLE: StorageSharing = {
  nodeId: "sample",
  shareId: "sample",
  linkAccess: "restricted",
  people: [{ email: "someone@example.com", role: "viewer", createdAt: new Date(0).toISOString() }],
  inherited: [],
};

/** The address, its role, and Invite: one line, the way people are added. */
function AddPerson({ nodeId }: { nodeId: string }) {
  const put = usePutStoragePerson();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StorageGrantRole>("viewer");
  const address = email.trim();
  return (
    // One line; on a phone the address takes a line of its own, role and Invite under it.
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!address) return;
        put.mutate(
          { id: nodeId, email: address, role },
          {
            onSuccess: () => setEmail(""),
            onError: (error) => storageErrorToast(error, "They were not added"),
          },
        );
      }}
    >
      <TextField
        aria-label="Email"
        type="email"
        autoFocus
        value={email}
        onChange={setEmail}
        className="min-w-0 flex-1 max-sm:basis-full"
      >
        <Input placeholder="name@company.com" autoComplete="off" />
      </TextField>
      <RoleSelect label="Role" value={role} onChange={setRole} />
      <Button type="submit" isDisabled={!address} isPending={put.isPending}>
        Invite
      </Button>
    </form>
  );
}

function RoleSelect(props: {
  label: string;
  value: StorageGrantRole;
  onChange: (role: StorageGrantRole) => void;
  isDisabled?: boolean;
}) {
  return (
    <div className="w-28 shrink-0">
      <Select
        aria-label={props.label}
        value={props.value}
        isDisabled={props.isDisabled}
        onChange={(next) => {
          const option = ROLES.find((r) => r.id === next);
          if (option) props.onChange(option.id);
        }}
      >
        <SelectTrigger />
        <SelectContent items={ROLES}>
          {(role) => (
            <SelectItem id={role.id} textValue={role.label}>
              {role.label}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Everyone it is shared with: their role and the way to remove them; inherited ones read-only. */
function People({ sharing }: { sharing: StorageSharing }) {
  const put = usePutStoragePerson();
  const remove = useRemoveStoragePerson();
  if (!sharing.people.length && !sharing.inherited.length) return null;
  return (
    <Group label="People with access">
      {sharing.people.map((person) => (
        <PersonRow key={person.email} email={person.email}>
          <RoleSelect
            label={`Role for ${person.email}`}
            value={person.role}
            onChange={(role) =>
              put.mutate(
                { id: sharing.nodeId, email: person.email, role },
                { onError: (error) => storageErrorToast(error, "The role was not changed") },
              )
            }
          />
          <Button
            intent="plain"
            size="sq-xs"
            aria-label={`Remove ${person.email}`}
            isPending={remove.isPending && remove.variables?.email === person.email}
            onPress={() =>
              remove.mutate(
                { id: sharing.nodeId, email: person.email },
                { onError: (error) => storageErrorToast(error, "They were not removed") },
              )
            }
          >
            <IconX />
          </Button>
        </PersonRow>
      ))}
      {sharing.inherited.map((person) => (
        <PersonRow
          key={`${person.nodeId}:${person.email}`}
          email={person.email}
          from={person.nodeName}
        >
          <span className="w-28 shrink-0 ps-2.5 text-sm text-muted-foreground">
            {roleLabel(person.role)}
          </span>
          {/* Holds the remove button's place, so roles line up with the rows above. */}
          <span aria-hidden className="size-6.5 shrink-0" />
        </PersonRow>
      ))}
    </Group>
  );
}

function PersonRow(props: { email: string; from?: string; children: React.ReactNode }) {
  return (
    <li className="flex min-h-10 items-center gap-2.5">
      <Avatar size="sm" initials={props.email.slice(0, 1).toUpperCase()} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{props.email}</span>
        {props.from && (
          <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <IconFolder className="size-3 shrink-0" />
            <span className="truncate">{props.from}</span>
          </span>
        )}
      </span>
      {props.children}
    </li>
  );
}

/** Restricted or anyone with the link, the link itself, and a new one in its place. */
function GeneralAccess({ sharing }: { sharing: StorageSharing }) {
  const setLink = useSetStorageLink();
  const anyone = sharing.linkAccess === "anyone";
  const Icon = anyone ? IconGlobe : IconLock;
  return (
    <Group label="General access">
      <li className="flex min-h-10 items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center">
          <Icon className="size-icon text-muted-foreground" />
        </span>
        <div className="w-52 min-w-0">
          <Select
            aria-label="General access"
            value={sharing.linkAccess}
            onChange={(next) => {
              const option = ACCESS.find((a) => a.id === next);
              if (option && option.id !== sharing.linkAccess) {
                setLink.mutate(
                  { id: sharing.nodeId, linkAccess: option.id },
                  { onError: (error) => storageErrorToast(error, "Access was not changed") },
                );
              }
            }}
          >
            <SelectTrigger />
            <SelectContent items={ACCESS}>
              {(access) => (
                <SelectItem id={access.id} textValue={access.label}>
                  {access.label}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </li>
      {sharing.shareId && (
        <li className="flex items-center gap-2">
          <LinkField url={shareUrl(sharing.shareId)} />
          <Button
            intent="outline"
            isPending={setLink.isPending && setLink.variables && "reset" in setLink.variables}
            onPress={() =>
              setLink.mutate(
                { id: sharing.nodeId, reset: true },
                { onError: (error) => storageErrorToast(error, "The link was not reset") },
              )
            }
          >
            Reset link
          </Button>
        </li>
      )}
    </Group>
  );
}

/** The link, read-only, with Copy inside it: the tick shows on the press, no toast. */
function LinkField({ url }: { url: string }) {
  const { copy, copied } = useClipboard();
  return (
    <TextField aria-label="Link" isReadOnly value={url} className="min-w-0 flex-1">
      <InputGroup>
        <Input />
        <Button
          intent="ghost"
          size="inset"
          aria-label="Copy link"
          className="text-muted-foreground hover:text-foreground"
          onPress={() => void copy(url)}
        >
          {copied ? <IconCheck className="size-icon" /> : <IconCopy className="size-icon" />}
        </Button>
      </InputGroup>
    </TextField>
  );
}

function Group(props: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm text-muted-foreground">{props.label}</h3>
      <ul className="flex flex-col gap-2">{props.children}</ul>
    </section>
  );
}
