import { Google } from "@ridemountainpig/svgl-react";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import {
  IconArrowRotateClockwise,
  IconInbox,
  IconKey,
  IconMail,
  IconSend,
  IconStar,
  IconTrash,
  IconUserMinus,
} from "@/components/icons/central";
import { Badge } from "@/components/ui/badge";
import { appToast } from "@/components/ui/toast";
import {
  useConnectGoogle,
  useDisconnectGoogle,
  useGoogleAccounts,
  useGoogleReturn,
} from "@/hooks/use-google-connection";
import {
  useAddSignInEmail,
  useRemoveSignInEmail,
  useSetPrimarySignInEmail,
  useSignInEmails,
} from "@/hooks/use-sign-in-emails.ts";
import { googleErrorText } from "@/lib/google-connection";
import { AddAccountDialog } from "./add-account-dialog";
import { SettingsAddRow } from "./kit/settings-add-row";
import { SettingsGroup, SettingsSection, SettingsSections } from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu, type SettingsRowMenuItem } from "./kit/settings-row-menu";
import { SettingsConfirmDialog } from "./kit/settings-stacked-dialog";

/** One address and what it does in Omni: signs you in, brings its inbox, or both. */
export interface Account {
  address: string;
  signIn?: { primary: boolean; verified: boolean };
  inbox?: { mailboxId: string; status: string };
}

const INBOX: Record<string, string> = {
  pending: "Inbox starting to sync",
  active: "Inbox syncing",
  error: "Inbox can't sign in. Reconnect it.",
  disabled: "Inbox paused",
};

/**
 * Sign-in emails and connected inboxes, one row per address: the primary first, then the rest
 * in the order they were added.
 */
export function mergeAccounts(
  emails: { email: string; primary: boolean; verified: boolean }[],
  inboxes: { mailboxId: string; address: string; status: string }[],
) {
  const rows = new Map<string, Account>();
  const key = (address: string) => address.trim().toLowerCase();
  for (const { email, primary, verified } of [...emails].sort(
    (a, b) => Number(b.primary) - Number(a.primary),
  )) {
    rows.set(key(email), { address: email, signIn: { primary, verified } });
  }
  for (const { mailboxId, address, status } of inboxes) {
    const row = rows.get(key(address)) ?? { address };
    rows.set(key(address), { ...row, inbox: { mailboxId, status } });
  }
  return [...rows.values()] satisfies Account[];
}

function describe(account: Account) {
  const parts: string[] = [];
  if (account.signIn?.verified) parts.push("Sign in");
  if (account.inbox) parts.push(INBOX[account.inbox.status] ?? `Inbox ${account.inbox.status}`);
  return parts.join(" · ") || undefined;
}

function useGoogleReturnToast() {
  const outcome = useGoogleReturn();
  const said = useRef(false);
  useEffect(() => {
    if (!outcome || said.current) return;
    said.current = true;
    if (outcome.kind === "connected") appToast.success("Inbox connected");
    else
      appToast.error("Couldn't connect Google", { description: googleErrorText(outcome.reason) });
  }, [outcome]);
}

const failed = (error: Error) => appToast.error(error.message);

type Confirm =
  | { kind: "stop-sign-in"; address: string }
  | { kind: "disconnect"; address: string; mailboxId: string };

export function AccountsPage() {
  useGoogleReturnToast();
  const emails = useSignInEmails();
  const google = useGoogleAccounts();
  const add = useAddSignInEmail();
  const setPrimary = useSetPrimarySignInEmail();
  const remove = useRemoveSignInEmail();
  const connect = useConnectGoogle("settings");
  const disconnect = useDisconnectGoogle();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const close = () => setConfirm(null);

  const googleReady = google.data?.available !== false;
  const accounts =
    emails.data && google.data ? mergeAccounts(emails.data.emails, google.data.accounts) : null;

  const sendLink = (address: string) =>
    add.mutate(address, {
      onSuccess: (sent) =>
        appToast.success(`Link sent to ${sent.email}`, {
          description: "Open it in this browser to confirm.",
        }),
      onError: failed,
    });

  const actions = (account: Account) => {
    const { address, signIn, inbox } = account;
    const items: SettingsRowMenuItem[] = [];
    if (signIn?.verified && !signIn.primary)
      items.push({
        icon: IconStar,
        label: "Make primary",
        onAction: () =>
          setPrimary.mutate(address, {
            onSuccess: () => appToast.success(`${address} is now primary`),
            onError: failed,
          }),
      });
    if (!signIn)
      items.push({ icon: IconKey, label: "Sign in with it", onAction: () => sendLink(address) });
    if (signIn && !signIn.verified)
      items.push({ icon: IconSend, label: "Resend link", onAction: () => sendLink(address) });
    if (!inbox && googleReady)
      items.push({
        icon: IconInbox,
        label: "Connect inbox",
        onAction: () => connect.mutate(address),
      });
    if (inbox?.status === "error")
      items.push({
        icon: IconArrowRotateClockwise,
        label: "Reconnect inbox",
        onAction: () => connect.mutate(address),
      });
    if (signIn && !signIn.primary)
      items.push({
        icon: IconTrash,
        label: "Stop signing in with it",
        danger: true,
        onAction: () => setConfirm({ kind: "stop-sign-in", address }),
      });
    if (inbox)
      items.push({
        icon: IconUserMinus,
        label: "Disconnect inbox",
        danger: true,
        onAction: () => setConfirm({ kind: "disconnect", address, mailboxId: inbox.mailboxId }),
      });
    return items;
  };

  return (
    <SettingsSections>
      <SettingsSection title="Emails">
        <Skeleton
          id="settings-accounts"
          data={accounts}
          sample={[{ address: "you@example.com", signIn: { primary: true, verified: true } }]}
          label="Loading accounts"
        >
          {(list) => (
            <SettingsGroup>
              {list.map((account) => {
                const items = actions(account);
                return (
                  <SettingsRow
                    key={account.address}
                    icon={account.inbox ? GoogleGlyph : IconMail}
                    label={account.address}
                    description={describe(account)}
                    badge={
                      account.signIn?.primary ? (
                        <Badge intent="secondary">Primary</Badge>
                      ) : account.signIn && !account.signIn.verified ? (
                        <Badge intent="warning">Unconfirmed</Badge>
                      ) : undefined
                    }
                    control={
                      items.length > 0 && (
                        <SettingsRowMenu label={`Actions for ${account.address}`} items={items} />
                      )
                    }
                  />
                );
              })}
              <SettingsAddRow
                label="Add an email"
                loading={connect.isPending}
                onPress={() => setAdding(true)}
              />
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <AddAccountDialog
        isOpen={adding}
        canConnectInbox={googleReady}
        onClose={() => setAdding(false)}
        onConnectInbox={(address) => connect.mutate(address)}
      />
      <SettingsConfirmDialog
        isOpen={confirm?.kind === "stop-sign-in"}
        onOpenChange={(open) => !open && close()}
        title="Stop signing in with this email?"
        description={`${confirm?.address ?? "It"} no longer signs you in. Your primary email still does.`}
        action="Stop"
        saving={remove.isPending}
        onConfirm={() =>
          confirm?.kind === "stop-sign-in" &&
          remove.mutate(confirm.address, { onSuccess: close, onError: failed })
        }
      />
      <SettingsConfirmDialog
        isOpen={confirm?.kind === "disconnect"}
        onOpenChange={(open) => !open && close()}
        title="Disconnect this inbox?"
        description={`Omni stops syncing ${confirm?.address ?? "it"} and its inbox leaves Omni. Your mail stays in Gmail.`}
        action="Disconnect"
        saving={disconnect.isPending}
        onConfirm={() =>
          confirm?.kind === "disconnect" &&
          disconnect.mutate(confirm.mailboxId, {
            onSuccess: close,
            onError: (error) =>
              appToast.error("Couldn't disconnect", { description: error.message }),
          })
        }
      />
    </SettingsSections>
  );
}

function GoogleGlyph(props: { className?: string }) {
  return <Google aria-hidden className={props.className} />;
}
