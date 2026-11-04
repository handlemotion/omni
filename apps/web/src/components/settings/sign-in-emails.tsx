// The addresses this person signs in with (ADR 0014), on the settings kit: one row per address,
// the primary one badged; a row's menu makes another primary or stops signing in with it (asked
// first); "Add an email" opens a form over settings that mails a confirmation link.
import { EnvelopeIcon, StarIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { Skeleton } from "skullet/react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import {
  useAddSignInEmail,
  useRemoveSignInEmail,
  useSetPrimarySignInEmail,
  useSignInEmails,
} from "@/hooks/use-sign-in-emails.ts";
import { SettingsAddRow } from "./kit/settings-add-row";
import { SettingsGroup, SettingsSection } from "./kit/settings-layout";
import { SettingsRow } from "./kit/settings-row";
import { SettingsRowMenu } from "./kit/settings-row-menu";
import { SettingsConfirmDialog, SettingsFormDialog } from "./kit/settings-stacked-dialog";

const failed = (error: Error) => appToast.error(error.message);

export function SignInEmails() {
  const emails = useSignInEmails();
  const setPrimary = useSetPrimarySignInEmail();
  const remove = useRemoveSignInEmail();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  return (
    <SettingsSection title="Sign-in emails" info="You can sign in with any confirmed address here.">
      <Skeleton
        id="settings-sign-in-emails"
        data={emails.data?.emails}
        sample={[{ email: "you@example.com", primary: true, verified: true }]}
        label="Loading sign-in emails"
      >
        {(list) => (
          <SettingsGroup>
            {list.map((row) => (
              <SettingsRow
                key={row.email}
                icon={EnvelopeIcon}
                label={row.email}
                badge={
                  row.primary ? (
                    <Badge intent="secondary">Primary</Badge>
                  ) : row.verified ? undefined : (
                    <Badge intent="warning">Unconfirmed</Badge>
                  )
                }
                control={
                  !row.primary && (
                    <SettingsRowMenu
                      label={`Actions for ${row.email}`}
                      items={[
                        ...(row.verified
                          ? [
                              {
                                icon: StarIcon,
                                label: "Make primary",
                                onAction: () =>
                                  setPrimary.mutate(row.email, {
                                    onSuccess: () =>
                                      appToast.success(`${row.email} is now primary`),
                                    onError: failed,
                                  }),
                              },
                            ]
                          : []),
                        {
                          icon: TrashIcon,
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
        description={`${removing ?? "It"} no longer signs you in. Your primary email still does.`}
        action="Stop"
        saving={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing, { onSuccess: () => setRemoving(null), onError: failed })
        }
      />
    </SettingsSection>
  );
}

function AddEmailDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const add = useAddSignInEmail();
  const [email, setEmail] = useState("");
  const address = email.trim();
  return (
    <SettingsFormDialog
      isOpen={isOpen}
      onOpenChange={(open) => !open && onClose()}
      title="Add a sign-in email"
      description="We mail it a link; open it in this browser to confirm."
      action="Send link"
      disabled={!address}
      saving={add.isPending}
      onSubmit={() =>
        add.mutate(address, {
          onSuccess: (sent) => {
            setEmail("");
            onClose();
            appToast.success(`Link sent to ${sent.email}`, {
              description: "Open it in this browser to confirm.",
            });
          },
          onError: failed,
        })
      }
    >
      <TextField type="email" isRequired autoFocus value={email} onChange={setEmail}>
        <Label>Email</Label>
        <Input placeholder="you@example.com" autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}
