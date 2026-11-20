import { Stack, useLocalSearchParams } from "expo-router";
import { PersonRow } from "@/components/crm/record-rows.tsx";
import { Fields, RecordView, Section } from "@/components/crm/record-view.tsx";
import { RecordActions } from "@/components/crm/record-actions.tsx";
import { RecordFilesSection } from "@/components/crm/record-files.tsx";
import { TimelineSection } from "@/components/crm/timeline-section.tsx";
import { dealValue, useDeal, useStageNames } from "@/lib/crm.ts";
import { listTime } from "@/lib/mail.ts";

/** A deal: its stage and value, and the people on it. */
export default function Deal() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const stages = useStageNames().data;
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <RecordView
        query={useDeal(id)}
        head={(data) => ({ name: data.deal.name, detail: dealValue(data.deal) })}
      >
        {(data) => (
          <>
            <RecordActions kind="deals" id={id} stageId={data.deal.stageId} />
            <Fields
              fields={[
                ["Stage", stages?.get(data.deal.stageId)],
                ["Last contacted", data.lastContactedAt ? listTime(data.lastContactedAt) : null],
              ]}
            />
            <Section title="People" items={data.people} render={(p) => <PersonRow person={p} />} />
            <RecordFilesSection
              kind="deals"
              id={id}
              name={data.deal.name}
              folderId={data.deal.folderNodeId}
            />
            <TimelineSection kind="deals" id={id} />
          </>
        )}
      </RecordView>
    </>
  );
}
