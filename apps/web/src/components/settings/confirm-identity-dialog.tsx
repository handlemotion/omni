import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { useConfirmIdentity, useCurrentUser, useSendEmailOtp } from "@/hooks/use-session.ts";
import { SettingsFormDialog } from "./kit/settings-stacked-dialog";

/**
 * Asks for an emailed code before a change Better Auth keeps for fresh sessions (adding a
 * passkey), so it never signs you out. Emails the code as it opens; mount it only while open.
 */
export function ConfirmIdentityDialog(props: { onClose: () => void; onConfirmed: () => void }) {
  const { email } = useCurrentUser();
  const send = useSendEmailOtp();
  const confirm = useConfirmIdentity();
  const [otp, setOtp] = useState("");
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    send.mutate({ email });
  }, [email, send]);

  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Confirm it's you"
      description="Enter the code we emailed you."
      action="Continue"
      disabled={otp.length < 6 || send.isPending}
      saving={confirm.isPending}
      onSubmit={() => confirm.mutate({ email, otp }, { onSuccess: props.onConfirmed })}
    >
      <TextField
        aria-label="Code"
        autoFocus
        autoComplete="one-time-code"
        inputMode="numeric"
        isRequired
        value={otp}
        onChange={(value) => setOtp(value.replace(/\D/g, "").slice(0, 6))}
      >
        <Input placeholder="6-digit code" maxLength={6} />
      </TextField>
    </SettingsFormDialog>
  );
}
