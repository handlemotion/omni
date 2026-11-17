import { Google } from "@ridemountainpig/svgl-react";
import { useEffect, useRef, useState } from "react";
import { Skeleton } from "skullet/react";
import { IconUserMinus } from "@/components/icons/central";
import { ConnectGoogleButton } from "@/components/google/connect-google";
import { appToast } from "@/components/ui/toast";
import {
  useDisconnectGoogle,
  useGoogleAccounts,
  useGoogleReturn,
} from "@/hooks/use-google-connection";
import { googleErrorText } from "@/lib/google-connection";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsConfirmDialog } from "./kit/settings-stacked-dialog";

const STATUS: Record<string, string> = {
  pending: "Starting to sync",
  active: "Syncing",
  error: "Can't sign in. Reconnect it.",
  disabled: "Paused",
};

function useGoogleReturnToast() {
  const outcome = useGoogleReturn();
  const said = useRef(false);
  useEffect(() => {
    if (!outcome || said.current) return;
    said.current = true;
    if (outcome.kind === "connected") appToast.success("Google account connected");
    else
      appToast.error("Couldn't connect Google", { description: googleErrorText(outcome.reason) });
  }, [outcome]);
}

export function ConnectedAccountsPage() {
  useGoogleReturnToast();
  const google = useGoogleAccounts();
  const disconnect = useDisconnectGoogle();
  const [leaving, setLeaving] = useState<{ mailboxId: string; address: string } | null>(null);

  const accounts = google.data?.accounts;
  const available = google.data?.available !== false;
  return (
    <SettingsSections>
      <SettingsSection
        title="Google"
        info="Your own Gmail, read and answered in Omni. Only you see it."
        actions={
          available &&
          accounts &&
          accounts.length > 0 && <ConnectGoogleButton from="settings" label="Connect another" />
        }
      >
        <Skeleton
          data={accounts ?? null}
          sample={[{ mailboxId: "sample", address: "you@gmail.com", status: "active" }]}
          label="Loading accounts"
        >
          {(list) =>
            list.length === 0 ? (
              available ? (
                <SettingsEmptyState
                  title="No Google account connected"
                  action={<ConnectGoogleButton from="settings" />}
                />
              ) : (
                <SettingsEmptyState
                  variant="restricted"
                  title="Google isn't set up on this server"
                  description="Whoever runs this Omni can add a Google OAuth client to turn it on."
                />
              )
            ) : (
              <SettingsGroup>
                {list.map((account) => (
                  <SettingsRow
                    key={account.mailboxId}
                    icon={GoogleGlyph}
                    label={account.address}
                    description={STATUS[account.status] ?? account.status}
                    control={
                      <SettingsRowMenu
                        label={`Actions for ${account.address}`}
                        items={[
                          {
                            icon: IconUserMinus,
                            label: "Disconnect",
                            danger: true,
                            onAction: () => setLeaving(account),
                          },
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
      <SettingsConfirmDialog
        isOpen={leaving !== null}
        onOpenChange={(open) => !open && setLeaving(null)}
        title="Disconnect this account?"
        description={`Omni stops syncing ${leaving?.address ?? "it"} and its inbox leaves Omni. Your mail stays in Gmail.`}
        action="Disconnect"
        saving={disconnect.isPending}
        onConfirm={() =>
          leaving &&
          disconnect.mutate(leaving.mailboxId, {
            onSuccess: () => setLeaving(null),
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
