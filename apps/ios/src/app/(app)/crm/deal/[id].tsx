import { Stack, useLocalSearchParams } from "expo-router";
import { PersonRow } from "@/components/crm/record-rows.tsx";
import { Fields, RecordView, Section } from "@/components/crm/record-view.tsx";
import { RecordActions } from "@/components/crm/record-actions.tsx";
import { ContractsSection } from "@/components/crm/contracts-section.tsx";
import { AccessSection, PlanSection } from "@/components/crm/plan-section.tsx";
import { RecordFilesSection } from "@/components/crm/record-files.tsx";
import { TaskSection } from "@/components/crm/task-section.tsx";
import { TimelineSection } from "@/components/crm/timeline-section.tsx";
import { dayText, dealValue, useDeal, useStageNames } from "@/lib/crm.ts";
import { useMemberNames } from "@/lib/crm-timeline.ts";
import { listTime } from "@/lib/mail.ts";

/** A deal (a project, once won): its stage and value, who owns it, and the people on it. */
export default function Deal() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const stages = useStageNames().data;
  const members = useMemberNames().data;
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <RecordView
        query={useDeal(id)}
        head={(data) => ({
          name: data.deal.name,
          detail: dealValue(data.deal),
          archived: !!data.deal.archivedAt,
        })}
      >
        {(data) => (
          <>
            <RecordActions
              kind="deals"
              id={id}
              name={data.deal.name}
              archived={!!data.deal.archivedAt}
              stageId={data.deal.stageId}
            />
            <Fields
              fields={[
                ["Stage", stages?.get(data.deal.stageId)],
                ["Owner", members?.get(data.deal.ownerMemberId ?? "")],
                ["Expected close", dayText(data.deal.expectedCloseOn)],
                ["Last contacted", data.lastContactedAt ? listTime(data.lastContactedAt) : null],
              ]}
            />
            <Section title="People" items={data.people} render={(p) => <PersonRow person={p} />} />
            <AccessSection dealId={id} />
            <PlanSection dealId={id} />
            <ContractsSection owner={{ kind: "deals", id }} />
            <RecordFilesSection
              kind="deals"
              id={id}
              name={data.deal.name}
              folderId={data.deal.folderNodeId}
            />
            <TaskSection kind="deals" id={id} />
            <TimelineSection kind="deals" id={id} />
          </>
        )}
      </RecordView>
    </>
  );
}
