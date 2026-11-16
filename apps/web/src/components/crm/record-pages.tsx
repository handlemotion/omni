// The record pages at `/crm/companies/$id`, `/crm/people/$id` and `/crm/deals/$id` (ADR 0039
// decision 1): details edited in place (each change a `PATCH` of that one field), related
// records, and the tabs. A company and a deal have Files and Contracts; a person has the timeline.
import { useState } from "react";
import { IconPencil, IconPlus } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import {
  useCrmCompany,
  useCrmDeal,
  useCrmPerson,
  useCrmStages,
  useMoveDeal,
  useUpdateCompany,
  useUpdateDeal,
  useUpdatePerson,
} from "@/hooks/use-crm.ts";
import { useMembers } from "@/hooks/use-organization.ts";
import { formatMoney, lastContactedAt, parseMoney, type CrmDealDetail } from "@/lib/crm.ts";
import { Contracts } from "./contracts.tsx";
import { crmErrorToast } from "./crm-errors.ts";
import { StageBadge } from "./list-pages.tsx";
import { NewDealDialog, NewPersonDialog } from "./new-records.tsx";
import { AddDomainDialog, AddPersonDialog, ChooseCompanyDialog } from "./record-dialogs.tsx";
import { ChoiceValue, LinkValue, PlainValue, TextValue } from "./record-fields.tsx";
import { RecordFiles } from "./record-files.tsx";
import { DetailSection, NoneRow, RecordLayout, RecordState, RelatedRow } from "./record-layout.tsx";
import { DAY } from "./record-list.tsx";
import { Timeline } from "./timeline.tsx";

const day = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : null);
const onFail = (fallback: string) => ({
  onError: (error: unknown) => crmErrorToast(error, fallback),
});

function AddButton(props: { label: string; onPress: () => void }) {
  return (
    <Button intent="plain" size="sq-xs" aria-label={props.label} onPress={props.onPress}>
      <IconPlus />
    </Button>
  );
}

function EditButton(props: { label: string; onPress: () => void }) {
  return (
    <Button intent="plain" size="sq-xs" aria-label={props.label} onPress={props.onPress}>
      <IconPencil />
    </Button>
  );
}

// Company -------------------------------------------------------------------------------------

export function CompanyPage({ id }: { id: string }) {
  const query = useCrmCompany(id);
  const update = useUpdateCompany();
  const [open, setOpen] = useState<"person" | "deal" | "domain" | null>(null);
  const close = () => setOpen(null);
  if (!query.data) return <RecordState list="companies" query={query} />;
  const { company, domains, people, deals } = query.data;
  const save = (change: { name?: string; description?: string | null }) =>
    update.mutate({ id, ...change }, onFail("The company was not changed"));
  return (
    <>
      <RecordLayout
        list="companies"
        name={company.name}
        square
        subtitle={domains[0]}
        details={
          <>
            <DetailSection title="Details">
              <TextValue
                label="Name"
                required
                value={company.name}
                onSave={(name) => name && save({ name })}
              />
              <TextValue
                label="Description"
                maxLength={2000}
                value={company.description}
                onSave={(description) => save({ description })}
              />
              <PlainValue label="Last contacted">{day(lastContactedAt(company))}</PlainValue>
              <PlainValue label="Added">{day(company.createdAt)}</PlainValue>
            </DetailSection>
            <DetailSection
              title="Domains"
              action={<AddButton label="Add domain" onPress={() => setOpen("domain")} />}
            >
              {domains.length ? (
                domains.map((domain) => (
                  <span key={domain} className="flex h-8 items-center truncate text-sm">
                    {domain}
                  </span>
                ))
              ) : (
                <NoneRow />
              )}
            </DetailSection>
            <DetailSection
              title="People"
              action={<AddButton label="Add person" onPress={() => setOpen("person")} />}
            >
              {people.length ? (
                people.map((person) => (
                  <RelatedRow
                    key={person.id}
                    kind="people"
                    id={person.id}
                    name={person.name}
                    meta={person.jobTitle}
                  />
                ))
              ) : (
                <NoneRow />
              )}
            </DetailSection>
            <DealsSection deals={deals} onAdd={() => setOpen("deal")} />
          </>
        }
        tabs={[
          { id: "timeline", label: "Timeline", panel: <Timeline kind="companies" id={id} /> },
          {
            id: "files",
            label: "Files",
            panel: (
              <RecordFiles
                kind="companies"
                id={id}
                name={company.name}
                folderId={company.folderNodeId}
              />
            ),
          },
          {
            id: "contracts",
            label: "Contracts",
            panel: <Contracts owner={{ companyId: id }} folderId={company.folderNodeId} />,
          },
        ]}
      />
      {open === "person" && <NewPersonDialog companyId={id} onClose={close} />}
      {open === "deal" && <NewDealDialog companyId={id} onClose={close} />}
      {open === "domain" && <AddDomainDialog companyId={id} onClose={close} />}
    </>
  );
}

function DealsSection(props: { deals: CrmDealDetail["deal"][]; onAdd?: () => void }) {
  const stages = useCrmStages().data ?? [];
  return (
    <DetailSection
      title="Deals"
      action={props.onAdd && <AddButton label="Add deal" onPress={props.onAdd} />}
    >
      {props.deals.length ? (
        props.deals.map((deal) => (
          <RelatedRow
            key={deal.id}
            kind="deals"
            id={deal.id}
            name={deal.name}
            meta={stages.find((stage) => stage.id === deal.stageId)?.name}
          />
        ))
      ) : (
        <NoneRow />
      )}
    </DetailSection>
  );
}

/** A company's name by id, for a person's or a deal's company field. */
function useCompanyName(companyId: string | null) {
  const company = useCrmCompany(companyId ?? "", { enabled: !!companyId });
  if (!companyId) return null;
  return company.data ? { id: companyId, name: company.data.company.name } : null;
}

// Person --------------------------------------------------------------------------------------

export function PersonPage({ id }: { id: string }) {
  const query = useCrmPerson(id);
  const update = useUpdatePerson();
  const [choosing, setChoosing] = useState(false);
  const companyId = query.data?.person.companyId ?? null;
  const company = useCompanyName(companyId);
  if (!query.data) return <RecordState list="people" query={query} />;
  const { person } = query.data;
  const save = (change: Parameters<typeof update.mutate>[0]) =>
    update.mutate(change, onFail("The person was not changed"));
  const primary = person.addresses.find((a) => a.isPrimary)?.address ?? null;
  return (
    <>
      <RecordLayout
        list="people"
        name={person.name}
        subtitle={person.jobTitle ?? primary}
        details={
          <DetailSection title="Details">
            <TextValue
              label="Name"
              required
              value={person.name}
              onSave={(name) => name && save({ id, name })}
            />
            <PlainValue label="Email">{primary}</PlainValue>
            {person.addresses
              .filter((a) => !a.isPrimary)
              .map((a) => (
                <PlainValue key={a.address} label="">
                  {a.address}
                </PlainValue>
              ))}
            <TextValue
              label="Title"
              maxLength={2000}
              value={person.jobTitle}
              onSave={(jobTitle) => save({ id, jobTitle })}
            />
            <TextValue
              label="Phone"
              type="tel"
              maxLength={2000}
              value={person.phone}
              onSave={(phone) => save({ id, phone })}
            />
            <LinkValue
              label="Company"
              to={company && { kind: "companies", ...company }}
              action={<EditButton label="Change company" onPress={() => setChoosing(true)} />}
            />
            <PlainValue label="Last contacted">{day(lastContactedAt(person))}</PlainValue>
            <PlainValue label="Added">{day(person.createdAt)}</PlainValue>
          </DetailSection>
        }
        tabs={[{ id: "timeline", label: "Timeline", panel: <Timeline kind="people" id={id} /> }]}
      />
      {choosing && (
        <ChooseCompanyDialog
          current={company}
          saving={update.isPending}
          onSave={(next) =>
            update.mutate(
              { id, companyId: next },
              { ...onFail("The company was not changed"), onSuccess: () => setChoosing(false) },
            )
          }
          onClose={() => setChoosing(false)}
        />
      )}
    </>
  );
}

// Deal ----------------------------------------------------------------------------------------

export function DealPage({ id }: { id: string }) {
  const query = useCrmDeal(id);
  const update = useUpdateDeal();
  const move = useMoveDeal();
  const stages = useCrmStages().data ?? [];
  const members = useMembers().data?.members ?? [];
  const [open, setOpen] = useState<"company" | "person" | null>(null);
  const company = useCompanyName(query.data?.deal.companyId ?? null);
  if (!query.data) return <RecordState list="deals" query={query} />;
  const { deal, people } = query.data;
  const save = (change: Parameters<typeof update.mutate>[0], then?: () => void) =>
    update.mutate(change, { ...onFail("The deal was not changed"), onSuccess: then });
  const owners = members.map((m) => ({ id: m.id, name: m.user.name || m.user.email }));
  const stage = stages.find((s) => s.id === deal.stageId);
  return (
    <>
      <RecordLayout
        list="deals"
        name={deal.name}
        subtitle={<StageBadge stage={stage} deal={deal} />}
        details={
          <>
            <DetailSection title="Details">
              <TextValue
                label="Name"
                required
                value={deal.name}
                onSave={(name) => name && save({ id, name })}
              />
              <ChoiceValue
                label="Stage"
                value={deal.stageId}
                options={stages}
                onSave={(stageId) => {
                  const next = stages.find((s) => s.id === stageId);
                  if (next)
                    move.mutate({ dealId: id, stage: next }, onFail("The deal was not moved"));
                }}
              />
              <TextValue
                label="Value"
                value={formatMoney(deal.valueMinor, deal.valueCurrency)}
                parse={(text) => (text ? (parseMoney(text) === null ? undefined : text) : null)}
                onSave={(text) => save({ id, valueMinor: text === null ? null : parseMoney(text) })}
              />
              <ChoiceValue
                label="Owner"
                value={deal.ownerMemberId}
                options={owners}
                onSave={(ownerMemberId) => save({ id, ownerMemberId })}
              />
              <LinkValue
                label="Company"
                to={company && { kind: "companies", ...company }}
                action={<EditButton label="Change company" onPress={() => setOpen("company")} />}
              />
              <PlainValue label="Won">{day(deal.wonAt)}</PlainValue>
              <PlainValue label="Added">{day(deal.createdAt)}</PlainValue>
            </DetailSection>
            <DetailSection
              title="People"
              action={<AddButton label="Add person" onPress={() => setOpen("person")} />}
            >
              {people.length ? (
                people.map((person) => (
                  <RelatedRow
                    key={person.id}
                    kind="people"
                    id={person.id}
                    name={person.name}
                    meta={person.jobTitle}
                  />
                ))
              ) : (
                <NoneRow />
              )}
            </DetailSection>
          </>
        }
        tabs={[
          { id: "timeline", label: "Timeline", panel: <Timeline kind="deals" id={id} /> },
          {
            id: "files",
            label: "Files",
            panel: (
              <RecordFiles kind="deals" id={id} name={deal.name} folderId={deal.folderNodeId} />
            ),
          },
          {
            id: "contracts",
            label: "Contracts",
            panel: <Contracts owner={{ dealId: id }} folderId={deal.folderNodeId} />,
          },
        ]}
      />
      {open === "company" && (
        <ChooseCompanyDialog
          current={company}
          saving={update.isPending}
          onSave={(companyId) => save({ id, companyId }, () => setOpen(null))}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "person" && (
        <AddPersonDialog
          title="Add person"
          exclude={people.map((p) => p.id)}
          saving={update.isPending}
          onAdd={(personId) =>
            save({ id, personIds: [...people.map((p) => p.id), personId] }, () => setOpen(null))
          }
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
