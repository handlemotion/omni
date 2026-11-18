import { Google } from "@ridemountainpig/svgl-react";
import { useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconArrowRotateClockwise,
  IconInbox,
  IconTag,
  IconTrash,
} from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { appToast } from "@/components/ui/toast";
import { useMailboxes } from "@/hooks/use-mail.ts";
import { useLabelMailbox, useYourMailboxes } from "@/hooks/use-mailbox-identity.ts";
import { useOnboarding } from "@/hooks/use-onboarding.ts";
import { useMember } from "@/hooks/use-session.ts";
import { useSignInEmails } from "@/hooks/use-sign-in-emails.ts";
import {
  useConnectGoogle,
  useDisconnectGoogle,
  useGoogleAccounts,
} from "@/hooks/use-google-connection";
import { SettingsAddRow } from "./kit/settings-add-row";
import { SettingsGroup, SettingsSection } from "./kit/settings-layout";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsConfirmDialog, SettingsRenameDialog } from "./kit/settings-stacked-dialog";
import { SettingsToggleRow } from "./kit/settings-toggle-row";
import { useOwnInboxCreation } from "./new-mailbox-dialog";
import { isManager } from "./workspace-pages";

const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

const STATUS: Record<string, string> = {
  pending: "Starting to sync",
  active: "Syncing",
  error: "Can't sign in",
  disabled: "Paused",
};

/** An inbox you have, or a Google address that could be one. */
export interface InboxRow {
  address: string;
  kind: "google" | "hosted";
  /** Set once it syncs; a Google address without one is off. */
  mailboxId?: string;
  status?: string;
}

const domainOf = (address: string) => address.split("@")[1]?.toLowerCase() ?? "";

/** Workspace domains whose mail stays at Google, so their addresses are Google accounts. */
export function useGoogleDomains() {
  const onboarding = useOnboarding();
  return new Set(
    onboarding.data?.domains
      .filter((d) => d.provider === "gmail")
      .map((d) => d.domain.toLowerCase()),
  );
}

export const isGoogleAddress = (address: string, googleDomains: Set<string>) =>
  GMAIL_DOMAINS.has(domainOf(address)) || googleDomains.has(domainOf(address));

/**
 * Connected Google inboxes, then your sign-in addresses at Google (Gmail, or a workspace domain
 * whose mail stays at Google) as inboxes switched off, then inboxes Omni hosts for you here.
 */
export function inboxRows(input: {
  google: { mailboxId: string; address: string; status: string }[];
  signIn: string[];
  googleDomains: Set<string>;
  hosted: { id: string; address: string; status: string }[];
}) {
  const rows: InboxRow[] = input.google.map((g) => ({ ...g, kind: "google" }));
  const seen = new Set(rows.map((row) => row.address.toLowerCase()));
  for (const address of input.signIn) {
    if (seen.has(address.toLowerCase())) continue;
    if (!isGoogleAddress(address, input.googleDomains)) continue;
    seen.add(address.toLowerCase());
    rows.push({ address, kind: "google" });
  }
  for (const box of input.hosted) {
    if (seen.has(box.address.toLowerCase())) continue;
    rows.push({ address: box.address, kind: "hosted", mailboxId: box.id, status: box.status });
  }
  return rows;
}

export function InboxesSection() {
  const { member } = useMember();
  const google = useGoogleAccounts();
  const emails = useSignInEmails();
  const mailboxes = useMailboxes();
  const googleDomains = useGoogleDomains();
  const connect = useConnectGoogle("settings");
  const disconnect = useDisconnectGoogle();
  const own = useOwnInboxCreation();
  const [leaving, setLeaving] = useState<{ mailboxId: string; address: string } | null>(null);
  const [labelling, setLabelling] = useState<{ mailboxId: string; label: string } | null>(null);
  const labelMailbox = useLabelMailbox();
  const labels = new Map(useYourMailboxes().map((box) => [box.id, box.label]));
  const saveLabel = (mailboxId: string, label: string | null) =>
    labelMailbox.mutate(
      { mailboxId, label },
      {
        onSuccess: () => setLabelling(null),
        onError: (error) =>
          appToast.error("Couldn't save the label", { description: error.message }),
      },
    );

  const googleReady = google.data?.available !== false;
  const canCreate = own.domains.length > 0 && (own.personal || isManager(member.role));
  const connected = new Set(google.data?.accounts.map((a) => a.mailboxId));
  const owned = new Set([
    ...connected,
    ...(mailboxes.data ?? []).filter((m) => m.role === "owner").map((m) => m.id),
  ]);
  const rows =
    google.data && emails.data && mailboxes.data
      ? inboxRows({
          google: google.data.accounts,
          signIn: googleReady
            ? emails.data.emails.filter((e) => e.verified).map((e) => e.email)
            : [],
          googleDomains,
          hosted: mailboxes.data.filter(
            (m) => m.orgId === member.orgId && m.kind === "personal" && !connected.has(m.id),
          ),
        })
      : null;

  return (
    <SettingsSection title="Inboxes">
      <Skeleton
        id="settings-account-inboxes"
        data={rows}
        sample={[{ address: "you@gmail.com", kind: "google" }] as InboxRow[]}
        label="Loading inboxes"
      >
        {(list) => (
          <SettingsGroup>
            {list.map((row) => {
              const label = row.mailboxId ? labels.get(row.mailboxId) : undefined;
              return (
                <SettingsToggleRow
                  key={row.address}
                  id={`inbox-${row.address}`}
                  icon={row.kind === "google" ? GoogleGlyph : IconInbox}
                  label={row.address}
                  hint={label ?? undefined}
                  description={row.mailboxId ? STATUS[row.status ?? ""] : undefined}
                  checked={row.mailboxId !== undefined}
                  disabled={row.kind === "hosted" || (!row.mailboxId && !googleReady)}
                  trailing={
                    <>
                      {row.status === "error" && (
                        <Button
                          size="sm"
                          intent="outline"
                          isPending={connect.isPending && connect.variables === row.address}
                          onPress={() => connect.mutate(row.address)}
                        >
                          Reconnect
                        </Button>
                      )}
                      {row.mailboxId && owned.has(row.mailboxId) && (
                        <LabelMenu
                          address={row.address}
                          label={label ?? null}
                          onEdit={() =>
                            row.mailboxId &&
                            setLabelling({ mailboxId: row.mailboxId, label: label ?? "" })
                          }
                          onClear={() => row.mailboxId && saveLabel(row.mailboxId, null)}
                          onReconnect={
                            row.kind === "google" && row.status !== "error"
                              ? () => connect.mutate(row.address)
                              : undefined
                          }
                        />
                      )}
                    </>
                  }
                  onCheckedChange={(on) => {
                    if (on) connect.mutate(row.address);
                    else if (row.mailboxId)
                      setLeaving({ mailboxId: row.mailboxId, address: row.address });
                  }}
                />
              );
            })}
            {canCreate && <SettingsAddRow label="Create an inbox" onPress={own.open} />}
            {googleReady && (
              <SettingsAddRow
                label="Connect Google"
                loading={connect.isPending}
                onPress={() => connect.mutate(undefined)}
              />
            )}
          </SettingsGroup>
        )}
      </Skeleton>
      {own.dialog}
      {labelling && (
        <SettingsRenameDialog
          title="Label this inbox"
          label="Label"
          maxLength={40}
          name={labelling.label}
          saving={labelMailbox.isPending}
          onClose={() => setLabelling(null)}
          onSave={(label) => saveLabel(labelling.mailboxId, label)}
        />
      )}
      <SettingsConfirmDialog
        isOpen={leaving !== null}
        onOpenChange={(open) => !open && setLeaving(null)}
        title="Turn off this inbox?"
        description={`Omni stops syncing ${leaving?.address ?? "it"} and its threads leave Omni. Your mail stays in Gmail.`}
        action="Turn off"
        saving={disconnect.isPending}
        onConfirm={() =>
          leaving &&
          disconnect.mutate(leaving.mailboxId, {
            onSuccess: () => setLeaving(null),
            onError: (error) =>
              appToast.error("Couldn't turn it off", { description: error.message }),
          })
        }
      />
    </SettingsSection>
  );
}

function LabelMenu(props: {
  address: string;
  label: string | null;
  onEdit: () => void;
  onClear: () => void;
  onReconnect?: (() => void) | undefined;
}) {
  return (
    <SettingsRowMenu
      label={`Inbox actions for ${props.address}`}
      items={[
        {
          icon: IconTag,
          label: props.label ? "Rename label" : "Add a label",
          onAction: props.onEdit,
        },
        ...(props.label
          ? [{ icon: IconTrash, label: "Remove label", onAction: props.onClear }]
          : []),
        ...(props.onReconnect
          ? [{ icon: IconArrowRotateClockwise, label: "Reconnect", onAction: props.onReconnect }]
          : []),
      ]}
    />
  );
}

export function GoogleGlyph(props: { className?: string }) {
  return <Google aria-hidden className={props.className} />;
}
