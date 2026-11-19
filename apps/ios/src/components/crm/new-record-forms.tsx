import { router } from "expo-router";
import { useState } from "react";
import { TextField } from "@/components/ui/text-field.tsx";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import {
  parseMoney,
  useCreateCompany,
  useCreateDeal,
  useCreatePerson,
} from "@/lib/crm-mutations.ts";
import { CompanyField, type CompanyChoice } from "./company-field.tsx";
import { SheetForm } from "./sheet-form.tsx";

/** The longest name the API takes. */
export const NAME_MAX = 500;

export function NewCompanyForm() {
  const create = useCreateCompany();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  return (
    <SheetForm
      title="New company"
      action="Create"
      disabled={!name.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          { name: name.trim(), ...(domain.trim() ? { domains: [domain.trim()] } : {}) },
          {
            onSuccess: ({ company }) =>
              router.replace({ pathname: "/crm/company/[id]", params: { id: company.id } }),
            onError: (error) => crmErrorAlert(error, "The company was not created"),
          },
        )
      }
    >
      <TextField
        label="Name"
        placeholder="Name"
        autoFocus
        autoCapitalize="words"
        maxLength={NAME_MAX}
        value={name}
        onChangeText={setName}
      />
      <TextField
        label="Domain"
        placeholder="Domain"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        maxLength={253}
        value={domain}
        onChangeText={setDomain}
      />
    </SheetForm>
  );
}

export function NewPersonForm(props: { company: CompanyChoice | null }) {
  const create = useCreatePerson();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [company, setCompany] = useState(props.company);
  return (
    <SheetForm
      title="New person"
      action="Create"
      disabled={!name.trim() || !address.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            name: name.trim(),
            address: address.trim(),
            ...(company ? { companyId: company.id } : {}),
          },
          {
            onSuccess: ({ person }) =>
              router.replace({ pathname: "/crm/person/[id]", params: { id: person.id } }),
            onError: (error) => crmErrorAlert(error, "The person was not added"),
          },
        )
      }
    >
      <TextField
        label="Name"
        placeholder="Name"
        autoFocus
        autoCapitalize="words"
        maxLength={NAME_MAX}
        value={name}
        onChangeText={setName}
      />
      <TextField
        label="Email"
        placeholder="Email"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
        maxLength={320}
        value={address}
        onChangeText={setAddress}
      />
      {props.company ? null : <CompanyField value={company} onChange={setCompany} />}
    </SheetForm>
  );
}

export function NewDealForm(props: { company: CompanyChoice | null }) {
  const create = useCreateDeal();
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [company, setCompany] = useState(props.company);
  const minor = parseMoney(value);
  return (
    <SheetForm
      title="New deal"
      action="Create"
      disabled={!name.trim() || (value.trim() !== "" && minor === null)}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            name: name.trim(),
            ...(company ? { companyId: company.id } : {}),
            ...(minor !== null ? { valueMinor: minor } : {}),
          },
          {
            onSuccess: ({ deal }) =>
              router.replace({ pathname: "/crm/deal/[id]", params: { id: deal.id } }),
            onError: (error) => crmErrorAlert(error, "The deal was not created"),
          },
        )
      }
    >
      <TextField
        label="Name"
        placeholder="Name"
        autoFocus
        maxLength={NAME_MAX}
        value={name}
        onChangeText={setName}
      />
      {props.company ? null : <CompanyField value={company} onChange={setCompany} />}
      <TextField
        label="Value"
        placeholder="Value"
        keyboardType="decimal-pad"
        value={value}
        onChangeText={setValue}
      />
    </SheetForm>
  );
}
