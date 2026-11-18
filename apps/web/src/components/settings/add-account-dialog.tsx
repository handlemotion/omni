import { useState } from "react";
import { Checkbox, CheckboxField, CheckboxGroup } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { appToast } from "@/components/ui/toast";
import { useAddSignInEmail } from "@/hooks/use-sign-in-emails.ts";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";

type Use = "sign-in" | "inbox";

/**
 * An address and what it should do: sign in (a confirmation link is mailed to it), bring its
 * inbox (Google's consent screen, opened on that address), or both.
 */
export function AddAccountDialog(props: {
  isOpen: boolean;
  canConnectInbox: boolean;
  onClose: () => void;
  onConnectInbox: (address: string) => void;
}) {
  const add = useAddSignInEmail();
  const [email, setEmail] = useState("");
  const [uses, setUses] = useState<Use[]>(["sign-in"]);
  const address = email.trim();
  const close = () => {
    setEmail("");
    setUses(["sign-in"]);
    props.onClose();
  };
  const inbox = props.canConnectInbox && uses.includes("inbox");

  const submit = () => {
    if (!uses.includes("sign-in")) {
      close();
      if (inbox) props.onConnectInbox(address);
      return;
    }
    add.mutate(address, {
      onSuccess: (sent) => {
        close();
        appToast.success(`Link sent to ${sent.email}`, {
          description: "Open it in this browser to confirm.",
        });
        if (inbox) props.onConnectInbox(sent.email);
      },
      onError: (error) => appToast.error(error.message),
    });
  };

  return (
    <SettingsFormDialog
      isOpen={props.isOpen}
      onOpenChange={(open) => !open && close()}
      title="Add an email"
      action={uses.includes("sign-in") ? "Send link" : "Connect"}
      disabled={!address || (!uses.includes("sign-in") && !inbox)}
      saving={add.isPending}
      onSubmit={submit}
    >
      <TextField type="email" isRequired autoFocus value={email} onChange={setEmail}>
        <Label>Email</Label>
        <Input placeholder="you@example.com" autoComplete="off" />
      </TextField>
      {props.canConnectInbox && (
        <CheckboxGroup
          aria-label="Use it to"
          value={uses}
          onChange={(next) => setUses(next as Use[])}
        >
          <CheckboxField value="sign-in">
            <Checkbox>Sign in</Checkbox>
          </CheckboxField>
          <CheckboxField value="inbox">
            <Checkbox>Inbox</Checkbox>
          </CheckboxField>
        </CheckboxGroup>
      )}
    </SettingsFormDialog>
  );
}
