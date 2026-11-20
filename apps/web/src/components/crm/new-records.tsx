import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { ComboBox, ComboBoxContent, ComboBoxInput, ComboBoxItem } from "@/components/ui/combo-box";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import {
  useCreateCompany,
  useCreateDeal,
  useCreatePerson,
  useCrmCompanies,
  useCrmDefaultCurrency,
} from "@/hooks/use-crm.ts";
import { useDebouncedValue } from "@/hooks/use-debounced-value.ts";
import { currencyCodes, parseMoney, valueCurrency } from "@/lib/crm.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { useWorkspaceSlug } from "@/hooks/use-workspaces.ts";

/** The longest name the API takes. */
export const NAME_MAX = 500;

/** Mount it while open, so the fields start empty. */
export function NewCompanyDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateCompany();
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && onClose()}
      title="New company"
      action="Create"
      disabled={!name.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          { name: name.trim(), ...(domain.trim() ? { domains: [domain.trim()] } : {}) },
          {
            onSuccess: ({ company }) =>
              void navigate({
                to: "/$workspace/crm/companies/$id",
                params: { workspace, id: company.id },
              }),
            onError: (error) => crmErrorToast(error, "The company was not created"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={NAME_MAX} value={name} onChange={setName}>
        <Label>Name</Label>
        <Input autoComplete="off" />
      </TextField>
      <TextField maxLength={253} value={domain} onChange={setDomain}>
        <Label>Domain</Label>
        <Input autoComplete="off" />
      </TextField>
    </SettingsFormDialog>
  );
}

export function NewPersonDialog(props: { companyId?: string; onClose: () => void }) {
  const create = useCreatePerson();
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(props.companyId ?? null);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="New person"
      action="Create"
      disabled={!name.trim() || !address.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          { name: name.trim(), address: address.trim(), ...(companyId ? { companyId } : {}) },
          {
            onSuccess: ({ person }) =>
              void navigate({
                to: "/$workspace/crm/people/$id",
                params: { workspace, id: person.id },
              }),
            onError: (error) => crmErrorToast(error, "The person was not added"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={NAME_MAX} value={name} onChange={setName}>
        <Label>Name</Label>
        <Input autoComplete="off" />
      </TextField>
      <TextField isRequired type="email" maxLength={320} value={address} onChange={setAddress}>
        <Label>Email</Label>
        <Input autoComplete="off" />
      </TextField>
      {!props.companyId && <CompanyPicker value={companyId} onChange={setCompanyId} />}
    </SettingsFormDialog>
  );
}

export function NewDealDialog(props: {
  companyId?: string;
  stageId?: string;
  onClose: () => void;
}) {
  const create = useCreateDeal();
  const navigate = useNavigate();
  const workspace = useWorkspaceSlug();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(props.companyId ?? null);
  const workspaceCurrency = useCrmDefaultCurrency();
  const [picked, setPicked] = useState<string | null>(null);
  const currency = picked ?? valueCurrency(null, workspaceCurrency);
  const minor = parseMoney(value);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="New deal"
      action="Create"
      disabled={!name.trim() || (value.trim() !== "" && minor === null)}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            name: name.trim(),
            ...(companyId ? { companyId } : {}),
            ...(props.stageId ? { stageId: props.stageId } : {}),
            ...(minor !== null ? { valueMinor: minor } : {}),
            currency,
          },
          {
            onSuccess: ({ deal }) =>
              void navigate({
                to: "/$workspace/crm/deals/$id",
                params: { workspace, id: deal.id },
              }),
            onError: (error) => crmErrorToast(error, "The deal was not created"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={NAME_MAX} value={name} onChange={setName}>
        <Label>Name</Label>
        <Input autoComplete="off" />
      </TextField>
      {!props.companyId && <CompanyPicker value={companyId} onChange={setCompanyId} />}
      <div className="flex items-end gap-2">
        <TextField value={value} onChange={setValue} inputMode="decimal" className="flex-1">
          <Label>Value</Label>
          <Input autoComplete="off" />
        </TextField>
        <CurrencyPicker value={currency} onChange={setPicked} />
      </div>
    </SettingsFormDialog>
  );
}

function CurrencyPicker(props: { value: string; onChange: (code: string) => void }) {
  const codes = useMemo(() => currencyCodes().map((code) => ({ id: code, name: code })), []);
  return (
    <Select
      aria-label="Currency"
      value={props.value}
      onChange={(code) => code && props.onChange(code)}
      className="w-24"
    >
      <SelectTrigger className="tabular-nums" />
      <SelectContent items={codes}>
        {(code) => (
          <SelectItem id={code.id} textValue={code.name}>
            {code.name}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

/** A company by name, searched on the server as it is typed. */
export function CompanyPicker(props: {
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  /** The chosen company's name, before the search has loaded it. */
  initialName?: string;
}) {
  const [text, setText] = useState(props.initialName ?? "");
  const q = useDebouncedValue(text.trim(), 200);
  const { companies } = useCrmCompanies(q);
  return (
    <ComboBox
      selectedKey={props.value}
      onSelectionChange={(key) => props.onChange(key === null ? null : String(key))}
      inputValue={text}
      onInputChange={setText}
      items={companies}
      allowsEmptyCollection
      menuTrigger="focus"
    >
      <Label>{props.label ?? "Company"}</Label>
      <ComboBoxInput />
      <ComboBoxContent items={companies}>
        {(company) => (
          <ComboBoxItem id={company.id} textValue={company.name}>
            {company.name}
          </ComboBoxItem>
        )}
      </ComboBoxContent>
    </ComboBox>
  );
}
