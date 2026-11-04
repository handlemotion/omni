// Settings pages about you: your profile and the accounts on this browser, how you sign in, and
// the keyboard shortcuts.
import { Fragment } from "react";
import { Skeleton } from "skullet/react";
import { IconKey } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Keyboard } from "@/components/ui/keyboard";
import { appToast } from "@/components/ui/toast";
import { useAddPasskey, useDeletePasskey, usePasskeys } from "@/hooks/use-organization.ts";
import {
  useDeviceSessions,
  useMember,
  useRevokeDeviceSession,
  useSignOut,
  useSwitchAccount,
} from "@/hooks/use-session.ts";
import { keyLabel, SHORTCUT_IDS, SHORTCUTS, type ShortcutDefinition } from "@/lib/shortcuts.ts";
import { SettingsAddRow } from "./kit/settings-add-row";
import { SettingsButtonRow } from "./kit/settings-button-row";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsValueRow } from "./kit/settings-value-row";

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/** A person's 32px picture, or their initial on the accent disc. */
export function PersonAvatar(props: { name: string; image?: string | null }) {
  return (
    <Avatar
      size="md"
      src={props.image ?? null}
      initials={props.name.slice(0, 1).toUpperCase()}
      className="bg-accent text-foreground outline-0"
    />
  );
}

export function ProfilePage() {
  const { user } = useMember();
  const signOut = useSignOut();
  const sessions = useDeviceSessions();
  const switchAccount = useSwitchAccount();
  const revoke = useRevokeDeviceSession();
  const name = user.name || user.email;
  const others = sessions.data?.filter((entry) => entry.user.id !== user.id);

  return (
    <SettingsSections>
      <SettingsSection title="Signed in">
        <SettingsGroup>
          <SettingsButtonRow
            avatar={<PersonAvatar name={name} image={user.image} />}
            label={name}
            description={user.name ? user.email : undefined}
            actionLabel="Log out"
            tone="danger"
            loading={signOut.isPending}
            onAction={() => signOut.mutate()}
          />
        </SettingsGroup>
      </SettingsSection>

      <SettingsSection title="Other accounts on this browser">
        <Skeleton id="settings-accounts" data={others} sample={[]} label="Loading accounts">
          {(accounts) => (
            <SettingsGroup>
              {accounts.length === 0 ? (
                <SettingsEmptyState
                  title="No other accounts"
                  description="Accounts you sign in to on this browser show up here, one press away."
                />
              ) : (
                accounts.map(({ user: other, session }) => (
                  <SettingsRow
                    key={session.token}
                    avatar={<PersonAvatar name={other.name || other.email} image={other.image} />}
                    label={other.name || other.email}
                    description={other.name ? other.email : undefined}
                    control={
                      <>
                        <Button
                          intent="outline"
                          isPending={
                            switchAccount.isPending && switchAccount.variables === session.token
                          }
                          onPress={() => switchAccount.mutate(session.token)}
                        >
                          Switch
                        </Button>
                        <SettingsRowMenu
                          label={`Actions for ${other.email}`}
                          items={[
                            {
                              label: "Sign out of this browser",
                              danger: true,
                              onAction: () => revoke.mutate(session.token),
                            },
                          ]}
                        />
                      </>
                    }
                  />
                ))
              )}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
    </SettingsSections>
  );
}

export function SecurityPage() {
  const passkeys = usePasskeys();
  const addPasskey = useAddPasskey();
  const deletePasskey = useDeletePasskey();

  return (
    <SettingsSections>
      <SettingsSection title="Passkeys">
        <Skeleton id="settings-passkeys" data={passkeys.data} sample={[]} label="Loading passkeys">
          {(list) => (
            <SettingsGroup>
              {list.length === 0 ? (
                <SettingsEmptyState
                  title="No passkeys yet"
                  description="Sign in with your fingerprint, face or device PIN instead of an emailed link."
                />
              ) : (
                list.map((passkey) => (
                  <SettingsRow
                    key={passkey.id}
                    icon={IconKey}
                    label={passkey.name || "Passkey"}
                    description={`Added ${DAY.format(new Date(passkey.createdAt))}`}
                    control={
                      <SettingsRowMenu
                        label={`Actions for ${passkey.name || "passkey"}`}
                        items={[
                          {
                            label: "Remove passkey",
                            danger: true,
                            onAction: () =>
                              deletePasskey.mutate(passkey.id, {
                                onError: () => appToast.error("The passkey could not be removed."),
                              }),
                          },
                        ]}
                      />
                    }
                  />
                ))
              )}
              <SettingsAddRow
                label="Add a passkey"
                loading={addPasskey.isPending}
                onPress={() =>
                  addPasskey.mutate(undefined, {
                    onError: (error) => appToast.error(error.message || "No passkey was added."),
                  })
                }
              />
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
    </SettingsSections>
  );
}

const SHORTCUT_GROUPS = [
  "Threads",
  "Go to",
  "General",
] as const satisfies readonly ShortcutDefinition["group"][];

export function ShortcutsPage() {
  return (
    <SettingsSections>
      {SHORTCUT_GROUPS.map((group) => (
        <SettingsSection key={group} title={group}>
          <SettingsGroup>
            {SHORTCUT_IDS.filter((id) => SHORTCUTS[id].group === group).map((id) => (
              <SettingsValueRow
                key={id}
                label={SHORTCUTS[id].label}
                value={<ShortcutKeys keys={SHORTCUTS[id].keys} />}
              />
            ))}
          </SettingsGroup>
        </SettingsSection>
      ))}
    </SettingsSections>
  );
}

/** Each alternative's keys as caps; "then" joins a sequence, "or" the alternatives. */
function ShortcutKeys({ keys }: { keys: ShortcutDefinition["keys"] }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {keys.map((sequence, i) => (
        <Fragment key={sequence.join(" ")}>
          {i > 0 && <span>or</span>}
          {sequence.map((key, j) => (
            <Fragment key={key}>
              {j > 0 && <span>then</span>}
              <span className="flex gap-0.5">
                {keyLabel(key).map((part) => (
                  <Keyboard key={part}>{part}</Keyboard>
                ))}
              </span>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
