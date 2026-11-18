import { useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import { IconMail, IconTrash } from "@/components/icons/central";
import { appToast } from "@/components/ui/toast";
import { useGoogleAccounts, useGoogleReturn } from "@/hooks/use-google-connection";
import {
  useRemoveSignInEmail,
  useSetPrimarySignInEmail,
  useSignInEmails,
} from "@/hooks/use-sign-in-emails.ts";
import { googleErrorText } from "@/lib/google-connection";
import { AddEmailDialog } from "./add-email-dialog";
import { GoogleGlyph, InboxesSection, isGoogleAddress, useGoogleDomains } from "./inboxes-section";
import { SettingsAddRow } from "./kit/settings-add-row";
import { SettingsGroup, SettingsSection, SettingsSections } from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsConfirmDialog } from "./kit/settings-stacked-dialog";

function useGoogleReturnToast() {
  const outcome = useGoogleReturn();
  const said = useRef(false);
  useEffect(() => {
    if (!outcome || said.current) return;
    said.current = true;
    if (outcome.kind === "connected") appToast.success("Inbox turned on");
    else
      appToast.error("Couldn't connect Google", { description: googleErrorText(outcome.reason) });
  }, [outcome]);
}

export function AccountsPage() {
  useGoogleReturnToast();
  return (
    <SettingsSections>
      <SignInSection />
      <InboxesSection />
    </SettingsSections>
  );
}

const failed = (error: Error) => appToast.error(error.message);

function SignInSection() {
  const emails = useSignInEmails();
  const setPrimary = useSetPrimarySignInEmail();
  const remove = useRemoveSignInEmail();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const list = emails.data?.emails;
  const googleDomains = useGoogleDomains();
  const google = useGoogleAccounts().data?.available !== false;

  const stop = async (address: string) => {
    const row = list?.find((e) => e.email === address);
    const next = list?.find((e) => e.email !== address && e.verified);
    if (row?.primary && next) await setPrimary.mutateAsync(next.email);
    await remove.mutateAsync(address);
  };

  return (
    <SettingsSection title="Sign in">
      <Skeleton
        id="settings-sign-in-emails"
        data={list}
        sample={[{ email: "you@example.com", primary: true, verified: true }]}
        label="Loading sign-in emails"
      >
        {(rows) => (
          <SettingsGroup>
            {rows.map((row) => (
              <SettingsRow
                key={row.email}
                icon={google && isGoogleAddress(row.email, googleDomains) ? GoogleGlyph : IconMail}
                label={row.email}
                control={
                  rows.length > 1 && (
                    <SettingsRowMenu
                      label={`Actions for ${row.email}`}
                      items={[
                        {
                          icon: IconTrash,
                          label: "Stop signing in with it",
                          danger: true,
                          onAction: () => setRemoving(row.email),
                        },
                      ]}
                    />
                  )
                }
              />
            ))}
            <SettingsAddRow label="Add an email" onPress={() => setAdding(true)} />
          </SettingsGroup>
        )}
      </Skeleton>

      <AddEmailDialog isOpen={adding} onClose={() => setAdding(false)} />
      <SettingsConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Stop signing in with this email?"
        description={`${removing ?? "It"} no longer signs you in.`}
        action="Stop"
        saving={remove.isPending || setPrimary.isPending}
        onConfirm={() =>
          removing &&
          stop(removing).then(
            () => setRemoving(null),
            (error: Error) => failed(error),
          )
        }
      />
    </SettingsSection>
  );
}
