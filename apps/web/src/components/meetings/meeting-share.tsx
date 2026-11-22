import { useState } from "react";
import { IconCheck, IconCopy, IconLock, IconUsers, IconX } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useClipboard } from "@/hooks/use-clipboard.ts";
import { useMeetingWrites } from "@/hooks/use-meetings.ts";
import type { Meeting } from "@/lib/meetings.ts";

type Role = "viewer" | "editor";
const ROLES: { id: Role; label: string }[] = [
  { id: "viewer", label: "Viewer" },
  { id: "editor", label: "Editor" },
];
const ACCESS = [
  { id: "restricted", label: "Only people invited" },
  { id: "workspace", label: "People in this workspace" },
] as const;

/**
 * Who a meeting is shared with, the way Drive shares a file: people by address with a role, the
 * workspace as general access, and the meeting's address to copy.
 */
export function ShareMeetingDialog(props: { meeting: Meeting; onClose: () => void }) {
  const { meeting } = props;
  const title = meeting.meeting.title ?? "Untitled meeting";
  return (
    <Dialog size="md" isOpen onOpenChange={(open) => !open && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">Share “{title}”</DialogTitle>
      </DialogHeader>
      <DialogBody className="gap-5">
        <AddPerson id={meeting.meeting.id} />
        <People meeting={meeting} />
        <GeneralAccess meeting={meeting} />
      </DialogBody>
    </Dialog>
  );
}

function AddPerson({ id }: { id: string }) {
  const { grant } = useMeetingWrites();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const address = email.trim();
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!address) return;
        grant.mutate(
          { id, address, role },
          {
            onSuccess: () => setEmail(""),
            onError: () => appToast.error("They were not added"),
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
      <Button type="submit" isDisabled={!address} isPending={grant.isPending}>
        Invite
      </Button>
    </form>
  );
}

function RoleSelect(props: { label: string; value: Role; onChange: (role: Role) => void }) {
  return (
    <div className="w-28 shrink-0">
      <Select
        aria-label={props.label}
        value={props.value}
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

function People({ meeting }: { meeting: Meeting }) {
  const { grant, revoke } = useMeetingWrites();
  const names = new Map(meeting.attendees.map((a) => [a.address, a.name]));
  const grants = meeting.sharing?.grants ?? [];
  if (!grants.length) return null;
  const id = meeting.meeting.id;
  return (
    <Group label="People with access">
      {grants.map((person) => (
        <li key={person.address} className="flex min-h-10 items-center gap-2.5">
          <Avatar size="sm" initials={(names.get(person.address) ?? person.address).slice(0, 1)} />
          <span className="flex min-w-0 flex-1 flex-col gap-y-0.5">
            <span className="truncate text-sm">{names.get(person.address) ?? person.address}</span>
            {names.get(person.address) && (
              <span className="truncate text-xs text-muted-foreground">{person.address}</span>
            )}
          </span>
          {person.role === "owner" ? (
            <span className="w-28 shrink-0 ps-2.5 text-sm text-muted-foreground">Owner</span>
          ) : (
            <RoleSelect
              label={`Role for ${person.address}`}
              value={person.role}
              onChange={(role) =>
                grant.mutate(
                  { id, address: person.address, role },
                  { onError: () => appToast.error("The role was not changed") },
                )
              }
            />
          )}
          {person.role === "owner" ? (
            <span aria-hidden className="size-6.5 shrink-0" />
          ) : (
            <Button
              intent="plain"
              size="sq-xs"
              aria-label={`Remove ${person.address}`}
              isPending={revoke.isPending && revoke.variables?.address === person.address}
              onPress={() =>
                revoke.mutate(
                  { id, address: person.address },
                  { onError: () => appToast.error("They were not removed") },
                )
              }
            >
              <IconX />
            </Button>
          )}
        </li>
      ))}
    </Group>
  );
}

function GeneralAccess({ meeting }: { meeting: Meeting }) {
  const { change } = useMeetingWrites();
  const { copy, copied } = useClipboard();
  const access = meeting.sharing?.access ?? "restricted";
  const Icon = access === "workspace" ? IconUsers : IconLock;
  return (
    <Group label="General access">
      <li className="flex min-h-10 items-center gap-2.5">
        <span className="grid size-6 shrink-0 place-items-center">
          <Icon className="size-icon text-muted-foreground" />
        </span>
        <div className="w-60 min-w-0">
          <Select
            aria-label="General access"
            value={access}
            onChange={(next) => {
              const option = ACCESS.find((a) => a.id === next);
              if (option && option.id !== access) {
                change.mutate(
                  { id: meeting.meeting.id, change: { access: option.id } },
                  { onError: () => appToast.error("Access was not changed") },
                );
              }
            }}
          >
            <SelectTrigger />
            <SelectContent items={[...ACCESS]}>
              {(option) => (
                <SelectItem id={option.id} textValue={option.label}>
                  {option.label}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
        <Button
          intent="outline"
          className="ms-auto"
          onPress={() => void copy(window.location.href)}
        >
          {copied ? <IconCheck data-slot="icon" /> : <IconCopy data-slot="icon" />}
          {copied ? "Copied" : "Copy link"}
        </Button>
      </li>
    </Group>
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
