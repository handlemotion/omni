import { Stack, useLocalSearchParams } from "expo-router";
import { Fields, RecordView } from "@/components/crm/record-view.tsx";
import { RecordActions } from "@/components/crm/record-actions.tsx";
import { TimelineSection } from "@/components/crm/timeline-section.tsx";
import { usePerson } from "@/lib/crm.ts";
import { listTime } from "@/lib/mail.ts";

/** A person: their role, how to reach them, and when you last wrote. */
export default function Person() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <RecordView
        query={usePerson(id)}
        head={(data) => ({
          name: data.person.name,
          detail: data.person.jobTitle,
          logo: data.person.addresses[0] ? { address: data.person.addresses[0].address } : null,
        })}
      >
        {(data) => (
          <>
            <RecordActions kind="people" id={id} />
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
                ["Last contacted", data.lastContactedAt ? listTime(data.lastContactedAt) : null],
              ]}
            />
            <TimelineSection kind="people" id={id} />
          </>
        )}
      </RecordView>
    </>
  );
}
