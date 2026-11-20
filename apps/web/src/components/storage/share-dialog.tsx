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
import { Switch, SwitchField } from "@/components/ui/switch";
import { TextField } from "@/components/ui/text-field";
import { useClipboard } from "@/hooks/use-clipboard.ts";
import {
  usePutStoragePerson,
  useRemoveStoragePerson,
  useSetStorageLink,
  useStorageSharing,
  useUploadSharing,
} from "@/hooks/use-storage.ts";
import type { StorageNode } from "@/lib/storage.ts";
import {
  shareUrl,
  type StorageGrantRole,
  type StorageLinkChange,
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
  { id: "workspace", label: "People in this workspace" },
  { id: "anyone", label: "Anyone with the link" },
];
const DAY_MS = 86_400_000;
const EXPIRY: { id: string; label: string; days: number | null }[] = [
  { id: "never", label: "Never", days: null },
  { id: "1", label: "In 1 day", days: 1 },
  { id: "7", label: "In 7 days", days: 7 },
  { id: "30", label: "In 30 days", days: 30 },
];
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const roleLabel = (role: StorageGrantRole) => ROLES.find((r) => r.id === role)?.label ?? role;

export function ShareDialog(props: { node: StorageNode; onClose: () => void }) {
  const sharing = useStorageSharing(props.node.id);
  return (
    <SharingDialog name={props.node.name} sharing={sharing.data?.sharing} onClose={props.onClose}>
      <AddPerson nodeId={props.node.id} />
    </SharingDialog>
  );
}

/**
 * Sharing a new file before it finishes uploading, by its upload id: its link only, which opens
 * on a page that follows the upload and becomes the file's link. People are added once it is a
 * file.
 */
export function ShareUploadDialog(props: { uploadId: string; name: string; onClose: () => void }) {
  const sharing = useUploadSharing(props.uploadId);
  return (
    <SharingDialog
      name={props.name}
      sharing={sharing.data?.sharing}
      onClose={props.onClose}
      uploading
    />
  );
}

function SharingDialog(props: {
  name: string;
  sharing: StorageSharing | undefined;
  uploading?: boolean;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog size="md" isOpen onOpenChange={(open) => !open && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">Share “{props.name}”</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-5">
        {props.children}
        <Skeleton id="storage-sharing" data={props.sharing} sample={SAMPLE} label="Loading sharing">
          {(state) => (
            <div className="flex flex-col gap-5">
              <People sharing={state} />
              <GeneralAccess sharing={state} uploading={props.uploading ?? false} />
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
  link: { expiresAt: null, hasPassword: false, downloads: true },
  policy: { publicLinks: true, outsideSharing: true },
  people: [{ email: "someone@example.com", role: "viewer", createdAt: new Date(0).toISOString() }],
  inherited: [],
};

function AddPerson({ nodeId }: { nodeId: string }) {
  const put = usePutStoragePerson();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StorageGrantRole>("viewer");
  const address = email.trim();
  return (
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

function GeneralAccess({ sharing, uploading }: { sharing: StorageSharing; uploading: boolean }) {
  const setLink = useSetStorageLink(uploading);
  const open = sharing.linkAccess !== "restricted";
  const Icon = sharing.linkAccess === "anyone" ? IconGlobe : IconLock;
  const choices = ACCESS.filter(
    (a) =>
      a.id !== "anyone" || sharing.policy?.publicLinks !== false || sharing.linkAccess === a.id,
  );
  return (
    <Group label="General access">
      <li className="flex min-h-10 items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center">
          <Icon className="size-icon text-muted-foreground" />
        </span>
        <div className="w-60 min-w-0">
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
            <SelectContent items={choices}>
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
      {open && sharing.link && (
        <LinkSettings nodeId={sharing.nodeId} link={sharing.link} uploading={uploading} />
      )}
    </Group>
  );
}

type Link = NonNullable<StorageSharing["link"]>;

function LinkSettings(props: { nodeId: string; link: Link; uploading: boolean }) {
  const { nodeId, link } = props;
  const setLink = useSetStorageLink(props.uploading);
  const change = (json: StorageLinkChange, failed: string) =>
    setLink.mutate(
      { id: nodeId, ...json },
      { onError: (error) => storageErrorToast(error, failed) },
    );
  const expiry = link.expiresAt
    ? [
        { id: "set", label: `Until ${DATE.format(new Date(link.expiresAt))}`, days: null },
        ...EXPIRY,
      ]
    : EXPIRY;
  return (
    <>
      <SettingRow label="Expires">
        <div className="w-40 shrink-0">
          <Select
            aria-label="Expires"
            value={link.expiresAt ? "set" : "never"}
            onChange={(next) => {
              const option = EXPIRY.find((e) => e.id === next);
              if (!option) return;
              const expiresAt = option.days
                ? new Date(Date.now() + option.days * DAY_MS).toISOString()
                : null;
              change({ expiresAt }, "The expiry was not changed");
            }}
          >
            <SelectTrigger />
            <SelectContent items={expiry}>
              {(option) => (
                <SelectItem id={option.id} textValue={option.label}>
                  {option.label}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </SettingRow>
      <PasswordRow hasPassword={link.hasPassword} onChange={change} />
      <SettingRow label="Allow downloads">
        <SwitchField
          aria-label="Allow downloads"
          isSelected={link.downloads}
          onChange={(downloads) => change({ downloads }, "Downloads were not changed")}
        >
          <Switch />
        </SwitchField>
      </SettingRow>
    </>
  );
}

function PasswordRow(props: {
  hasPassword: boolean;
  onChange: (json: StorageLinkChange, failed: string) => void;
}) {
  const [password, setPassword] = useState("");
  if (props.hasPassword) {
    return (
      <SettingRow label="Password">
        <Button
          intent="outline"
          onPress={() => props.onChange({ password: null }, "The password was not removed")}
        >
          Remove password
        </Button>
      </SettingRow>
    );
  }
  return (
    <SettingRow label="Password">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (password.length < 4) return;
          props.onChange({ password }, "The password was not set");
          setPassword("");
        }}
      >
        <TextField
          aria-label="Link password"
          type="password"
          value={password}
          onChange={setPassword}
          className="w-40"
        >
          <Input autoComplete="new-password" />
        </TextField>
        <Button type="submit" intent="outline" isDisabled={password.length < 4}>
          Set
        </Button>
      </form>
    </SettingRow>
  );
}

function SettingRow(props: { label: string; children: React.ReactNode }) {
  return (
    <li className="flex min-h-10 items-center gap-2.5">
      <span aria-hidden className="size-6 shrink-0" />
      <span className="min-w-0 flex-1 text-sm">{props.label}</span>
      {props.children}
    </li>
  );
}

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
