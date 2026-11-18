import { useState } from "react";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useAddSignInEmail } from "@/hooks/use-sign-in-emails.ts";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";

/** Mails a confirmation link to a new sign-in address. */
export function AddEmailDialog(props: { isOpen: boolean; onClose: () => void }) {
  const add = useAddSignInEmail();
  const [email, setEmail] = useState("");
  const address = email.trim();
  const close = () => {
    setEmail("");
    props.onClose();
  };
  return (
    <SettingsFormDialog
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && close()}
      title="Add an email"
      action="Send link"
      disabled={!address}
      saving={add.isPending}
      onSubmit={() =>
        add.mutate(address, {
          onSuccess: (sent) => {
            close();
            appToast.success(`Link sent to ${sent.email}`, {
              description: "Open it in this browser to confirm.",
            });
          },
          onError: (error) => appToast.error(error.message),
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
