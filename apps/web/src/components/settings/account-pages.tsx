// Settings pages about you: your name and the accounts on this browser, how you sign in and where
// you are signed in, and the keyboard shortcuts.
import { IconKey1 } from "central-icons-outlined/IconKey1";
import { IconMacbook } from "central-icons-outlined/IconMacbook";
import { IconPencil } from "central-icons-outlined/IconPencil";
import { IconPhone } from "central-icons-outlined/IconPhone";
import { IconTablet } from "central-icons-outlined/IconTablet";
import { IconTrashCanSimple } from "central-icons-outlined/IconTrashCanSimple";
import { Fragment, useEffect, useState } from "react";
import { Skeleton } from "skullet/react";
import { IconCircleDashed } from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Keyboard } from "@/components/ui/keyboard";
import { appToast } from "@/components/ui/toast";
import {
  useAddPasskey,
  useDeletePasskey,
  usePasskeys,
  useRenamePasskey,
} from "@/hooks/use-organization.ts";
import {
  useCurrentSession,
  useDeviceSessions,
  useMember,
  useRevokeDeviceSession,
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
  useSignOut,
  useSwitchAccount,
  useUpdateName,
} from "@/hooks/use-session.ts";
import { keyLabel, SHORTCUT_IDS, SHORTCUTS, type ShortcutDefinition } from "@/lib/shortcuts.ts";
import { useRemoveProfilePicture, useUploadProfilePicture } from "@/hooks/use-pictures.ts";
import { SettingsAddRow } from "./kit/settings-add-row";
import { SettingsInputRow } from "./kit/settings-input-row";
import { useSettingsPendingChanges } from "./kit/use-settings-pending-changes";
import { SettingsAvatarRow } from "./kit/settings-avatar-row";
import { SignInEmails } from "./sign-in-emails";
import {
  SettingsEmptyState,
  SettingsGroup,
  SettingsSection,
  SettingsSections,
} from "./kit/settings-layout";
import { SettingsRow, settingsRowTextEndClassName, type SettingsRowIcon } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsConfirmDialog, SettingsRenameDialog } from "./kit/settings-stacked-dialog";

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "5 minutes ago", "yesterday", "3 weeks ago": how long since a session was last used. */
export function ago(date: Date | string, now = Date.now()) {
  const seconds = (new Date(date).getTime() - now) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
    ["week", 604_800],
    ["month", 2_629_800],
  ];
  if (seconds > -60) return "just now";
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [next, length] of steps) if (-seconds >= length) [unit, size] = [next, length];
  return RELATIVE.format(Math.round(seconds / size), unit);
}

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

/**
 * A name edited in place: the field holds the saved value; changing it raises the page's
 * pending-changes toast (Save, Discard), never a button in the row (transitive's kit).
 */
export function NameInputRow(props: {
  id: string;
  label: string;
  saved: string;
  message: string;
  placeholder?: string;
  saving: boolean;
  onSave: (name: string) => void;
  /** Keeps the draft valid as it's typed (a handle: lowercase, dashes). */
  normalize?: (value: string) => string;
  /** What the draft saves as, and is compared as (a handle drops a trailing dash). */
  finalize?: (value: string) => string;
}) {
  const [draft, setDraft] = useState(props.saved);
  const next = (props.finalize ?? ((value: string) => value))(draft.trim());
  // Once a save lands (or someone else changes it), the field shows the saved value.
  useEffect(() => setDraft(props.saved), [props.saved]);
  useSettingsPendingChanges({
    dirty: next !== "" && next !== props.saved,
    message: props.message,
    saving: props.saving,
    onDiscard: () => setDraft(props.saved),
    onSave: () => props.onSave(next),
  });
  return (
    <SettingsInputRow
      id={props.id}
      label={props.label}
      value={draft}
      placeholder={props.placeholder}
      maxLength={120}
      autoComplete="off"
      onChange={(event) =>
        setDraft(
          props.normalize ? props.normalize(event.currentTarget.value) : event.currentTarget.value,
        )
      }
    />
  );
}

export function ProfilePage() {
  const { user } = useMember();
  const signOut = useSignOut();
  const sessions = useDeviceSessions();
  const switchAccount = useSwitchAccount();
  const revoke = useRevokeDeviceSession();
  const rename = useUpdateName();
  const uploadPicture = useUploadProfilePicture();
  const removePicture = useRemoveProfilePicture();
  const name = user.name || user.email;
  const others = sessions.data?.filter((entry) => entry.user.id !== user.id);

  return (
    <SettingsSections>
      <SettingsSection title="Identity">
        <SettingsGroup>
          <SettingsAvatarRow
            label="Picture"
            description="PNG, JPEG, WebP or GIF, up to 2 MB"
            avatar={<PersonAvatar name={name} image={user.image} />}
            hasImage={!!user.image}
            busy={uploadPicture.isPending || removePicture.isPending}
            onUpload={(file) =>
              uploadPicture.mutate(file, {
                onError: (error) => appToast.error(error.message || "That picture didn't upload."),
              })
            }
            onRemove={() =>
              removePicture.mutate(undefined, {
                onError: () => appToast.error("Your picture could not be removed."),
              })
            }
          />
          <NameInputRow
            id="settings-your-name"
            label="Name"
            saved={user.name ?? ""}
            placeholder="Your name"
            message="Name changed"
            saving={rename.isPending}
            onSave={(next) =>
              rename.mutate(next, {
                onError: () => appToast.error("Your name could not be changed."),
              })
            }
          />
        </SettingsGroup>
      </SettingsSection>

      <SignInEmails />

      <SettingsSection
        title="Accounts on this browser"
        info="Sign in to another account from the sign-in page to switch between them here."
      >
        {/* One skeleton for the whole card: a wrapper inside it would break the hairlines. */}
        <Skeleton id="settings-accounts" data={others} sample={[]} label="Loading accounts">
          {(accounts) => (
            <SettingsGroup>
              <SettingsRow
                avatar={<PersonAvatar name={name} image={user.image} />}
                label={name}
                hint="current"
                description={user.name ? user.email : undefined}
                control={
                  // Red at Rodrigo's call, though signing out can be undone by signing back in.
                  <Button
                    intent="danger"
                    isPending={signOut.isPending}
                    onPress={() => signOut.mutate()}
                  >
                    Log out
                  </Button>
                }
              />
              {accounts.map(({ user: other, session }) => (
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
                            icon: IconCircleDashed,
                            label: "Log out of this account",
                            onAction: () => revoke.mutate(session.token),
                          },
                        ]}
                      />
                    </>
                  }
                />
              ))}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>
    </SettingsSections>
  );
}

/** A label people can tell apart in the list; the authenticator gives none (transitive's). */
function devicePasskeyName() {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "Passkey on iPhone";
  if (/iPad/.test(agent)) return "Passkey on iPad";
  if (/Android/.test(agent)) return "Passkey on Android";
  if (/Mac OS X|Macintosh/.test(agent)) return "Passkey on Mac";
  if (/Windows/.test(agent)) return "Passkey on Windows";
  if (/CrOS/.test(agent)) return "Passkey on ChromeOS";
  if (/Linux/.test(agent)) return "Passkey on Linux";
  return "Passkey";
}

/** "Safari on iPhone" and the glyph for its kind of device, from a session's user agent. */
function describeDevice(agent: string | null | undefined): {
  name: string;
  icon: SettingsRowIcon;
} {
  const ua = agent ?? "";
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Version\/.*Safari\//.test(ua)
            ? "Safari"
            : null;
  const icon =
    os === "iPhone" || (os === "Android" && /Mobile/.test(ua))
      ? IconPhone
      : os === "iPad" || os === "Android"
        ? IconTablet
        : IconMacbook;
  const name =
    browser && os
      ? `${browser} on ${os}`
      : (browser ?? (os ? `Browser on ${os}` : "Unknown device"));
  return { name, icon };
}

/** What a stacked dialog over the Security page is doing, if anything. */
type SecurityDialog =
  | { kind: "rename-passkey"; id: string; name: string }
  | { kind: "remove-passkey"; id: string; name: string }
  | { kind: "sign-out-device"; token: string; name: string }
  | { kind: "sign-out-others" };

export function SecurityPage() {
  const session = useCurrentSession();
  const passkeys = usePasskeys();
  const addPasskey = useAddPasskey();
  const renamePasskey = useRenamePasskey();
  const deletePasskey = useDeletePasskey();
  const sessions = useSessions();
  const revokeSession = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const [dialog, setDialog] = useState<SecurityDialog | null>(null);
  const close = () => setDialog(null);
  const otherDevices = sessions.data?.filter((entry) => entry.token !== session.token) ?? [];

  return (
    <SettingsSections>
      <SettingsSection
        title="Passkeys"
        info="Sign in with your fingerprint, face or a security key instead of an emailed link."
      >
        <Skeleton id="settings-passkeys" data={passkeys.data} sample={[]} label="Loading passkeys">
          {(list) => (
            <SettingsGroup>
              {list.length === 0 && (
                <SettingsEmptyState
                  title="No passkeys yet"
                  description="Add one to sign in without waiting for an email."
                />
              )}
              {list.map((passkey) => {
                const name = passkey.name || "Passkey";
                return (
                  <SettingsRow
                    key={passkey.id}
                    icon={IconKey1}
                    label={name}
                    hint={passkey.backedUp ? "synced" : "this device only"}
                    description={`Added ${DAY.format(new Date(passkey.createdAt))}`}
                    control={
                      <SettingsRowMenu
                        label={`Actions for ${name}`}
                        items={[
                          {
                            icon: IconPencil,
                            label: "Rename",
                            onAction: () =>
                              setDialog({ kind: "rename-passkey", id: passkey.id, name }),
                          },
                          {
                            icon: IconTrashCanSimple,
                            label: "Remove passkey",
                            danger: true,
                            onAction: () =>
                              setDialog({ kind: "remove-passkey", id: passkey.id, name }),
                          },
                        ]}
                      />
                    }
                  />
                );
              })}
              <SettingsAddRow
                label="Add a passkey"
                loading={addPasskey.isPending}
                onPress={() =>
                  addPasskey.mutate(devicePasskeyName(), {
                    onError: (error) => appToast.error(error.message || "No passkey was added."),
                  })
                }
              />
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      <SettingsSection
        title="Devices"
        info="Everywhere you are signed in. Sign out of one you don't recognize."
        actions={
          otherDevices.length > 1 && (
            <Button intent="outline" onPress={() => setDialog({ kind: "sign-out-others" })}>
              Sign out of all others
            </Button>
          )
        }
      >
        <Skeleton id="settings-devices" data={sessions.data} sample={[]} label="Loading devices">
          {(list) => (
            <SettingsGroup>
              {list.map((entry) => {
                const current = entry.token === session.token;
                // This device is this browser, whatever agent signed the session in (a script, an
                // app webview); the others are what their sessions recorded.
                const device = describeDevice(current ? navigator.userAgent : entry.userAgent);
                const seen = current ? "Active now" : `Last active ${ago(entry.updatedAt)}`;
                return (
                  <SettingsRow
                    key={entry.id}
                    icon={device.icon}
                    label={device.name}
                    hint={current ? "this device" : undefined}
                    description={entry.ipAddress ? `${seen} · ${entry.ipAddress}` : seen}
                    // The current device has no menu: signing it out is Log out, on Profile.
                    className={current ? settingsRowTextEndClassName : undefined}
                    control={
                      !current && (
                        <SettingsRowMenu
                          label={`Actions for ${device.name}`}
                          items={[
                            {
                              icon: IconCircleDashed,
                              label: "Sign out",
                              danger: true,
                              onAction: () =>
                                setDialog({
                                  kind: "sign-out-device",
                                  token: entry.token,
                                  name: device.name,
                                }),
                            },
                          ]}
                        />
                      )
                    }
                  />
                );
              })}
            </SettingsGroup>
          )}
        </Skeleton>
      </SettingsSection>

      {dialog?.kind === "rename-passkey" && (
        <SettingsRenameDialog
          key={dialog.id}
          title="Rename passkey"
          label="Name"
          name={dialog.name}
          maxLength={60}
          saving={renamePasskey.isPending}
          onClose={close}
          onSave={(name) =>
            renamePasskey.mutate(
              { id: dialog.id, name },
              {
                onSuccess: close,
                onError: () => appToast.error("The passkey could not be renamed."),
              },
            )
          }
        />
      )}
      <SettingsConfirmDialog
        isOpen={dialog?.kind === "remove-passkey"}
        onOpenChange={(open) => !open && close()}
        title="Remove passkey?"
        description={`${dialog?.kind === "remove-passkey" ? dialog.name : "This passkey"} will no longer sign you in. You can still sign in with an emailed link.`}
        action="Remove"
        saving={deletePasskey.isPending}
        onConfirm={() =>
          dialog?.kind === "remove-passkey" &&
          deletePasskey.mutate(dialog.id, {
            onSuccess: close,
            onError: () => appToast.error("The passkey could not be removed."),
          })
        }
      />
      <SettingsConfirmDialog
        isOpen={dialog?.kind === "sign-out-device"}
        onOpenChange={(open) => !open && close()}
        title="Sign out of this device?"
        description={`${dialog?.kind === "sign-out-device" ? dialog.name : "That device"} will need to sign in again to open Omni.`}
        action="Sign out"
        saving={revokeSession.isPending}
        onConfirm={() =>
          dialog?.kind === "sign-out-device" &&
          revokeSession.mutate(dialog.token, {
            onSuccess: close,
            onError: () => appToast.error("That device could not be signed out."),
          })
        }
      />
      <SettingsConfirmDialog
        isOpen={dialog?.kind === "sign-out-others"}
        onOpenChange={(open) => !open && close()}
        title="Sign out of all other devices?"
        description={`${otherDevices.length} devices will need to sign in again. This one stays signed in.`}
        action="Sign out"
        saving={revokeOthers.isPending}
        onConfirm={() =>
          revokeOthers.mutate(undefined, {
            onSuccess: close,
            onError: () => appToast.error("The other devices could not be signed out."),
          })
        }
      />
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
              // One line and a 20px cap: 44px rows keep 12px above and below the caps.
              <SettingsRow
                key={id}
                className={`min-h-11 ${settingsRowTextEndClassName}`}
                label={SHORTCUTS[id].label}
                control={<ShortcutKeys keys={SHORTCUTS[id].keys} />}
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
    <span className="flex items-center gap-1.5 text-xs text-subtle-foreground">
      {keys.map((sequence, i) => (
        <Fragment key={sequence.join(" ")}>
          {i > 0 && <span>or</span>}
          {sequence.map((key, j) => (
            <Fragment key={key}>
              {j > 0 && <span>then</span>}
              <span className="flex gap-0.5">
                {keyLabel(key).map((part) => (
                  // Foreground on the cap: the keys are what this page is for.
                  <Keyboard key={part} className="text-foreground">
                    {part}
                  </Keyboard>
                ))}
              </span>
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}
