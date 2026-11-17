import { useLocalSearchParams } from "expo-router";
import { DealRow, PersonRow } from "@/components/crm/record-rows.tsx";
import { Fields, RecordView, Section } from "@/components/crm/record-view.tsx";
import { useCompany, useStageNames } from "@/lib/crm.ts";

/** A company: what it does, its domains, its people and its deals. */
export default function Company() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const stages = useStageNames().data;
  return (
    <RecordView query={useCompany(id)} title={(data) => data.company.name}>
      {(data) => (
        <>
          <Fields
            fields={[
              ["Description", data.company.description],
              ["Domains", data.domains.join(", ")],
            ]}
          />
          <Section title="People" items={data.people} render={(p) => <PersonRow person={p} />} />
          <Section
            title="Deals"
            items={data.deals}
            render={(d) => <DealRow deal={d} stage={stages?.get(d.stageId)} />}
          />
        </>
      )}
    </RecordView>
  );
}
