import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet } from "react-native";
import { TextField } from "@/components/ui/text-field.tsx";
import type { CrmCompany, CrmDeal, CrmPerson } from "@/lib/crm.ts";
import { isCurrencyCode, useDealCurrency } from "@/lib/crm-currency.ts";
import { crmErrorAlert } from "@/lib/crm-errors.ts";
import {
  parseMoney,
  useUpdateCompany,
  useUpdateDeal,
  useUpdatePerson,
} from "@/lib/crm-mutations.ts";
import { space } from "@/theme/tokens.ts";
import { CompanyField, type CompanyChoice } from "./company-field.tsx";
import { CloseDateField, OwnerField, ValueField } from "./form-fields.tsx";
import { NAME_MAX } from "./new-record-forms.tsx";
import { SheetForm } from "./sheet-form.tsx";

const orNull = (text: string) => text.trim() || null;

function changed<T extends Record<string, unknown>>(next: T, before: Partial<T>) {
  const out: Partial<T> = {};
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (next[key] !== before[key]) out[key] = next[key];
  }
  return out;
}

const done = (fallback: string) => ({
  onSuccess: () => router.back(),
  onError: (error: unknown) => crmErrorAlert(error, fallback),
});

export function EditCompanyForm(props: { company: CrmCompany }) {
  const update = useUpdateCompany();
  const { company } = props;
  const [name, setName] = useState(company.name);
  const [description, setDescription] = useState(company.description ?? "");
  const [owner, setOwner] = useState(company.ownerMemberId ?? null);
  return (
    <SheetForm
      title="Edit company"
      action="Save"
      disabled={!name.trim()}
      saving={update.isPending}
      onSubmit={() => {
        const change = changed(
          { name: name.trim(), description: orNull(description), ownerMemberId: owner },
          {
            name: company.name,
            description: company.description,
            ownerMemberId: company.ownerMemberId ?? null,
          },
        );
        if (!Object.keys(change).length) return router.back();
        update.mutate({ id: company.id, ...change }, done("The company was not changed"));
      }}
    >
      <TextField
        label="Name"
        placeholder="Name"
        autoCapitalize="words"
        maxLength={NAME_MAX}
        value={name}
        onChangeText={setName}
      />
      <TextField
        label="Description"
        placeholder="Description"
        multiline
        maxLength={2000}
        value={description}
        onChangeText={setDescription}
        style={styles.multiline}
      />
      <OwnerField value={owner} onChange={setOwner} />
    </SheetForm>
  );
}

export function EditPersonForm(props: { person: CrmPerson; company: CompanyChoice | null }) {
  const update = useUpdatePerson();
  const { person } = props;
  const [name, setName] = useState(person.name);
  const [jobTitle, setJobTitle] = useState(person.jobTitle ?? "");
  const [phone, setPhone] = useState(person.phone ?? "");
  const [company, setCompany] = useState(props.company);
  const [owner, setOwner] = useState(person.ownerMemberId ?? null);
  return (
    <SheetForm
      title="Edit person"
      action="Save"
      disabled={!name.trim()}
      saving={update.isPending}
      onSubmit={() => {
        const change = changed(
          {
            name: name.trim(),
            jobTitle: orNull(jobTitle),
            phone: orNull(phone),
            companyId: company?.id ?? null,
            ownerMemberId: owner,
          },
          { ...person, ownerMemberId: person.ownerMemberId ?? null },
        );
        if (!Object.keys(change).length) return router.back();
        update.mutate({ id: person.id, ...change }, done("The person was not changed"));
      }}
    >
      <TextField
        label="Name"
        placeholder="Name"
        autoCapitalize="words"
        maxLength={NAME_MAX}
        value={name}
        onChangeText={setName}
      />
      <TextField
        label="Title"
        placeholder="Title"
        maxLength={2000}
        value={jobTitle}
        onChangeText={setJobTitle}
      />
      <TextField
        label="Phone"
        placeholder="Phone"
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        maxLength={2000}
        value={phone}
        onChangeText={setPhone}
      />
      <CompanyField value={company} onChange={setCompany} />
      <OwnerField value={owner} onChange={setOwner} />
    </SheetForm>
  );
}

function valueChange(deal: CrmDeal, minor: number | null, currency: string) {
  const same = minor === deal.valueMinor && (minor === null || currency === deal.valueCurrency);
  return same ? {} : { valueMinor: minor, currency };
}

/**
 * A deal's value goes with its currency, every time (ADR 0054 decision 7): changing either
 * sends both, so a value saves in a workspace with no default currency.
 */
export function EditDealForm(props: { deal: CrmDeal; company: CompanyChoice | null }) {
  const update = useUpdateDeal();
  const { deal } = props;
  const [name, setName] = useState(deal.name);
  const [value, setValue] = useState(deal.valueMinor === null ? "" : String(deal.valueMinor / 100));
  const [code, setCode] = useState<string | null>(null);
  const fallback = useDealCurrency(deal.valueCurrency).currency;
  const currency = code ?? fallback;
  const [company, setCompany] = useState(props.company);
  const [owner, setOwner] = useState(deal.ownerMemberId);
  const [closeOn, setCloseOn] = useState(deal.expectedCloseOn ?? null);
  const minor = parseMoney(value);
  const badValue = value.trim() !== "" && (minor === null || !isCurrencyCode(currency));
  return (
    <SheetForm
      title="Edit deal"
      action="Save"
      disabled={!name.trim() || badValue}
      saving={update.isPending}
      onSubmit={() => {
        const change = {
          ...changed(
            {
              name: name.trim(),
              companyId: company?.id ?? null,
              ownerMemberId: owner,
              expectedCloseOn: closeOn,
            },
            { ...deal, expectedCloseOn: deal.expectedCloseOn ?? null },
          ),
          ...valueChange(deal, minor, currency),
        };
        if (!Object.keys(change).length) return router.back();
        update.mutate({ id: deal.id, ...change }, done("The deal was not changed"));
      }}
    >
      <TextField
        label="Name"
        placeholder="Name"
        maxLength={NAME_MAX}
        value={name}
        onChangeText={setName}
      />
      <ValueField value={value} onValue={setValue} currency={currency} onCurrency={setCode} />
      <CompanyField value={company} onChange={setCompany} />
      <CloseDateField value={closeOn} onChange={setCloseOn} />
      <OwnerField value={owner} onChange={setOwner} />
    </SheetForm>
  );
}

const styles = StyleSheet.create({
  multiline: { height: 120, paddingTop: space(3), textAlignVertical: "top" },
});
