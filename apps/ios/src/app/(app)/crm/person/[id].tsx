import { Stack, useLocalSearchParams } from "expo-router";
import { DealRow } from "@/components/crm/record-rows.tsx";
import { Fields, RecordView, Section } from "@/components/crm/record-view.tsx";
import { RecordActions } from "@/components/crm/record-actions.tsx";
import { TaskSection } from "@/components/crm/task-section.tsx";
import { TimelineSection } from "@/components/crm/timeline-section.tsx";
import { usePerson, useStageNames } from "@/lib/crm.ts";
import { useMemberNames } from "@/lib/crm-timeline.ts";
import { listTime } from "@/lib/mail.ts";

/** A person: their role, how to reach them, who owns them, their deals, and when you last wrote. */
export default function Person() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const stages = useStageNames().data;
  const members = useMemberNames().data;
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <RecordView
        query={usePerson(id)}
        head={(data) => ({
          name: data.person.name,
          detail: data.person.jobTitle,
          logo: data.person.addresses[0] ? { address: data.person.addresses[0].address } : null,
          archived: !!data.person.archivedAt,
        })}
      >
        {(data) => (
          <>
            <RecordActions
              kind="people"
              id={id}
              name={data.person.name}
              archived={!!data.person.archivedAt}
            />
            <Fields
              fields={[
                [
                  "Email",
                  data.person.addresses.map((a) => ({
                    text: a.address,
                    href: `mailto:${a.address}`,
                  })),
                ],
                [
                  "Phone",
                  data.person.phone
                    ? {
                        text: data.person.phone,
                        href: `tel:${data.person.phone.replace(/[^\d+]/g, "")}`,
                      }
                    : null,
                ],
                ["Owner", members?.get(data.person.ownerMemberId ?? "")],
                ["Last contacted", data.lastContactedAt ? listTime(data.lastContactedAt) : null],
              ]}
            />
            <Section
              title="Deals"
              items={data.deals ?? []}
              render={(d) => <DealRow deal={d} stage={stages?.get(d.stageId)} />}
            />
            <TaskSection kind="people" id={id} />
            <TimelineSection kind="people" id={id} />
          </>
        )}
      </RecordView>
    </>
  );
}
