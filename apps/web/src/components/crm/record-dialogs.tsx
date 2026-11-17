import { useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { ComboBox, ComboBoxContent, ComboBoxInput, ComboBoxItem } from "@/components/ui/combo-box";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { useAddDomain, useCrmPeople } from "@/hooks/use-crm.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { CompanyPicker } from "./new-records.tsx";

/** Picks the company `onSave` sets; mount it while open. */
export function ChooseCompanyDialog(props: {
  current: { id: string; name: string } | null;
  saving: boolean;
  onSave: (companyId: string) => void;
  onClose: () => void;
}) {
  const [companyId, setCompanyId] = useState<string | null>(props.current?.id ?? null);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Company"
      action="Save"
      disabled={!companyId || companyId === props.current?.id}
      saving={props.saving}
      onSubmit={() => companyId && props.onSave(companyId)}
    >
      <CompanyPicker value={companyId} onChange={setCompanyId} initialName={props.current?.name} />
    </SettingsFormDialog>
  );
}

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
      saving={add.isPending}
      onSubmit={() =>
        add.mutate(
          { id: props.companyId, domain: domain.trim().toLowerCase() },
          {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "The domain was not added"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={253} value={domain} onChange={setDomain}>
        <Label>Domain</Label>
        <Input autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}

/** Picks a person by name or address, searched on the server as it is typed. */
export function AddPersonDialog(props: {
  title: string;
  /** Already there: left out of the choices. */
  exclude: string[];
  saving: boolean;
  onAdd: (personId: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const q = useDebouncedValue(text.trim(), 200);
  const people = useCrmPeople(q).people.filter((person) => !props.exclude.includes(person.id));
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title={props.title}
      action="Add"
      disabled={!personId}
      saving={props.saving}
      onSubmit={() => personId && props.onAdd(personId)}
    >
      <ComboBox
        selectedKey={personId}
        onSelectionChange={(key) => setPersonId(key === null ? null : String(key))}
        inputValue={text}
        onInputChange={setText}
        items={people}
        allowsEmptyCollection
        menuTrigger="focus"
        autoFocus
      >
        <Label>Person</Label>
        <ComboBoxInput />
        <ComboBoxContent items={people}>
          {(person) => (
            <ComboBoxItem id={person.id} textValue={person.name}>
              {person.name}
            </ComboBoxItem>
          )}
        </ComboBoxContent>
      </ComboBox>
    </SettingsFormDialog>
  );
}
