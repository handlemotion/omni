import { Stack, useLocalSearchParams } from "expo-router";
import { DealRow, PersonRow } from "@/components/crm/record-rows.tsx";
import { Fields, RecordView, Section } from "@/components/crm/record-view.tsx";
import { RecordActions } from "@/components/crm/record-actions.tsx";
import { RecordFilesSection } from "@/components/crm/record-files.tsx";
import { TimelineSection } from "@/components/crm/timeline-section.tsx";
import { useCompany, useStageNames } from "@/lib/crm.ts";
import { useMemberNames } from "@/lib/crm-timeline.ts";

/** A company: what it does, who owns it, its domains, its people and its deals. */
export default function Company() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const stages = useStageNames().data;
  const members = useMemberNames().data;
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <RecordView
        query={useCompany(id)}
        head={(data) => ({
          name: data.company.name,
          logo: data.domains[0] ? { domain: data.domains[0] } : null,
          archived: !!data.company.archivedAt,
        })}
      >
        {(data) => (
          <>
            <RecordActions
              kind="companies"
              id={id}
              name={data.company.name}
              archived={!!data.company.archivedAt}
            />
            <Fields
              fields={[
                ["Description", data.company.description],
                ["Owner", members?.get(data.company.ownerMemberId ?? "")],
                ["Domains", data.domains.map((d) => ({ text: d, href: `https://${d}` }))],
              ]}
            />
            <Section title="People" items={data.people} render={(p) => <PersonRow person={p} />} />
            <Section
              title="Deals"
              items={data.deals}
              render={(d) => <DealRow deal={d} stage={stages?.get(d.stageId)} />}
            />
            <RecordFilesSection
              kind="companies"
              id={id}
              name={data.company.name}
              folderId={data.company.folderNodeId}
            />
            <TimelineSection kind="companies" id={id} />
          </>
        )}
      </RecordView>
    </>
  );
}
