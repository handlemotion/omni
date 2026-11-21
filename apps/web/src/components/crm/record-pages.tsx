import { useFreelancer } from "@/hooks/use-freelancer.ts";
import { CreateMenu } from "./create-menu.tsx";
import { useState } from "react";
import {
  useCrmCompany,
  useCrmDeal,
  useCrmDefaultCurrency,
  useCrmPerson,
  useCrmStages,
  useMoveDeal,
  useOwners,
  useUpdateDeal,
  useUpdatePerson,
} from "@/hooks/use-crm.ts";
import { formatMoney, lastContactedAt, valueCurrency } from "@/lib/crm.ts";
import { isProject } from "@/lib/crm-lists.ts";
import { Contracts } from "./contracts.tsx";
import { AccessSection } from "./project-access.tsx";
import { ProjectPlan } from "./project-plan.tsx";
import { crmErrorToast } from "./crm-errors.ts";
import { StageBadge } from "./list-pages.tsx";
import { CompanyValue } from "./new-records.tsx";
import { ArchivedBadge, RecordActions } from "./record-actions.tsx";
import { AddAddressDialog } from "./record-dialogs.tsx";
import { ChoiceValue, DayValue, MoneyValue, PlainValue, TextValue } from "./record-fields.tsx";
import { RecordFiles } from "./record-files.tsx";
import { byAddress } from "@/components/avatar/sender-avatar";
import { MemberAvatar, NoMemberAvatar } from "./member-avatar.tsx";
import { DealMark } from "./deal-mark.tsx";
import { DetailSection, RecordLayout, RecordState } from "./record-layout.tsx";
import { DAY } from "./record-list.tsx";
import { AddressesSection, DealsSection, PeopleSection } from "./record-sections.tsx";
import { RecordTasks } from "./tasks.tsx";
import { Timeline } from "./timeline.tsx";

const day = (iso: string | null) => (iso ? DAY.format(new Date(iso)) : null);
const onFail = (fallback: string) => ({
  onError: (error: unknown) => crmErrorToast(error, fallback),
});

const NO_OWNER = "none";

export function OwnerValue(props: {
  value: string | null | undefined;
  onSave: (id: string | null) => void;
}) {
  const owners = useOwners();
  return (
    <ChoiceValue
      label="Owner"
      value={props.value ?? NO_OWNER}
      options={[...owners, { id: NO_OWNER, name: "No owner", image: null }]}
      onSave={(id) => props.onSave(id === NO_OWNER ? null : id)}
      mark={(owner) =>
        owner.id === NO_OWNER ? (
          <NoMemberAvatar />
        ) : (
          <MemberAvatar name={owner.name} image={owner.image} />
        )
      }
    />
  );
}

function useCompanyName(companyId: string | null) {
  const company = useCrmCompany(companyId ?? "", { enabled: !!companyId });
  if (!companyId) return null;
  return company.data
    ? {
        id: companyId,
        name: company.data.company.name,
        domain: company.data.company.domain ?? company.data.domains[0] ?? null,
      }
    : null;
}

export function PersonPage({ id }: { id: string }) {
  const query = useCrmPerson(id);
  const update = useUpdatePerson();
  const [open, setOpen] = useState<"address" | null>(null);
  const companyId = query.data?.person.companyId ?? null;
  const company = useCompanyName(companyId);
  if (!query.data) return <RecordState list="people" query={query} />;
  const { person } = query.data;
  const save = (change: Parameters<typeof update.mutate>[0]) =>
    update.mutate(change, onFail("The person was not changed"));
  const primary = person.addresses.find((a) => a.isPrimary)?.address ?? null;
  const archived = !!person.archivedAt;
  return (
    <>
      <RecordLayout
        list="people"
        here={{ kind: "people", id }}
        name={person.name}
        who={byAddress(primary)}
        subtitle={person.jobTitle ?? primary}
        badge={archived && <ArchivedBadge />}
        actions={
          <>
            <CreateMenu record={{ kind: "people", id, name: person.name }} />
            <RecordActions kind="people" id={id} name={person.name} archived={archived} />
          </>
        }
        details={
          <>
            <DetailSection>
              <TextValue
                label="Name"
                required
                value={person.name}
                onSave={(name) => name && save({ id, name })}
              />
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
              <CompanyValue current={company} onSave={(companyId) => save({ id, companyId })} />
              <OwnerValue
                value={person.ownerMemberId}
                onSave={(ownerMemberId) => save({ id, ownerMemberId })}
              />
              <PlainValue label="Last contacted">{day(lastContactedAt(person))}</PlainValue>
              <PlainValue label="Added">{day(person.createdAt)}</PlainValue>
            </DetailSection>
            <AddressesSection person={person} onAdd={() => setOpen("address")} />
            <DealsSection deals={query.data.deals ?? []} />
          </>
        }
        tabs={[
          { id: "timeline", label: "Timeline", panel: <Timeline kind="people" id={id} /> },
          { id: "tasks", label: "Tasks", panel: <RecordTasks kind="people" id={id} /> },
        ]}
      />
      {open === "address" && <AddAddressDialog personId={id} onClose={() => setOpen(null)} />}
    </>
  );
}

export function DealPage({ id }: { id: string }) {
  const query = useCrmDeal(id);
  const update = useUpdateDeal();
  const move = useMoveDeal();
  const stages = useCrmStages().data ?? [];
  const workspaceCurrency = useCrmDefaultCurrency();
  const freelancer = useFreelancer();
  const company = useCompanyName(query.data?.deal.companyId ?? null);
  if (!query.data) return <RecordState list="deals" query={query} />;
  const { deal, people } = query.data;
  const save = (change: Parameters<typeof update.mutate>[0], then?: () => void) =>
    update.mutate(change, { ...onFail("The deal was not changed"), onSuccess: then });
  const stage = stages.find((s) => s.id === deal.stageId);
  const currency = valueCurrency(deal.valueCurrency, workspaceCurrency);
  const archived = !!deal.archivedAt;
  return (
    <>
      <RecordLayout
        list={isProject(deal.stageKind) ? "projects" : "deals"}
        here={{ kind: "deals", id }}
        name={deal.name}
        mark={<DealMark deal={deal} client={company} size={company ? 40 : 28} />}
        subtitle={company?.name}
        badge={
          <>
            <StageBadge stage={stage} deal={deal} />
            {archived && <ArchivedBadge />}
          </>
        }
        actions={
          <>
            <CreateMenu record={{ kind: "deals", id, name: deal.name }} />
            <RecordActions kind="deals" id={id} name={deal.name} archived={archived} />
          </>
        }
        details={
          <>
            <DetailSection>
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
              {!freelancer && (
                <MoneyValue
                  label="Value"
                  value={formatMoney(deal.valueMinor, null)}
                  currency={currency}
                  onSaveAmount={(valueMinor) => save({ id, valueMinor, currency })}
                  onSaveCurrency={(next) => save({ id, currency: next })}
                />
              )}
              <DayValue
                label="Close date"
                value={deal.expectedCloseOn ?? null}
                onSave={(expectedCloseOn) => save({ id, expectedCloseOn })}
              />
              <OwnerValue
                value={deal.ownerMemberId}
                onSave={(ownerMemberId) => save({ id, ownerMemberId })}
              />
              <CompanyValue current={company} onSave={(companyId) => save({ id, companyId })} />
              <PlainValue label="Won">{day(deal.wonAt)}</PlainValue>
              <PlainValue label="Added">{day(deal.createdAt)}</PlainValue>
            </DetailSection>
            <PeopleSection
              people={people}
              picking={update.isPending}
              onPick={(personId) => save({ id, personIds: [...people.map((p) => p.id), personId] })}
              onRemove={(personId) =>
                save({ id, personIds: people.map((p) => p.id).filter((p) => p !== personId) })
              }
            />
            <AccessSection dealId={id} />
          </>
        }
        tabs={[
          { id: "timeline", label: "Timeline", panel: <Timeline kind="deals" id={id} /> },
          { id: "plan", label: "Plan", panel: <ProjectPlan dealId={id} /> },
          { id: "tasks", label: "Tasks", panel: <RecordTasks kind="deals" id={id} /> },
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
    </>
  );
}
