import { useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { useAddDomain, useUpdatePerson } from "@/hooks/use-crm.ts";
import { crmErrorToast } from "./crm-errors.ts";

export function AddDomainDialog(props: { companyId: string; onClose: () => void }) {
  const add = useAddDomain();
  const [domain, setDomain] = useState("");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Add domain"
      action="Add"
      disabled={!domain.trim()}
      onSubmit={() => {
        add
          .mutateAsync({ id: props.companyId, domain: domain.trim().toLowerCase() })
          .catch((error: unknown) => crmErrorToast(error, "The domain was not added"));
        props.onClose();
      }}
    >
      <TextField isRequired autoFocus maxLength={253} value={domain} onChange={setDomain}>
        <Label>Domain</Label>
        <Input autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}

export function AddAddressDialog(props: { personId: string; onClose: () => void }) {
  const update = useUpdatePerson();
  const [address, setAddress] = useState("");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Add address"
      action="Add"
      disabled={!address.trim()}
      onSubmit={() => {
        update
          .mutateAsync({ id: props.personId, addresses: { add: [address.trim()] } })
          .catch((error: unknown) => crmErrorToast(error, "The address was not added"));
        props.onClose();
      }}
    >
      <TextField
        isRequired
        autoFocus
        type="email"
        maxLength={320}
        value={address}
        onChange={setAddress}
      >
        <Label>Email</Label>
        <Input autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}
