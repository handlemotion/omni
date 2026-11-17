import { useLocalSearchParams } from "expo-router";
import { Fields, RecordView } from "@/components/crm/record-view.tsx";
import { usePerson } from "@/lib/crm.ts";
import { listTime } from "@/lib/mail.ts";

/** A person: their role, how to reach them, and when you last wrote. */
export default function Person() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <RecordView query={usePerson(id)} title={(data) => data.person.name}>
      {(data) => (
        <Fields
          fields={[
            ["Job title", data.person.jobTitle],
            ["Email", data.person.addresses.map((a) => a.address).join("\n")],
            ["Phone", data.person.phone],
            ["Last contacted", data.lastContactedAt ? listTime(data.lastContactedAt) : null],
          ]}
        />
      )}
    </RecordView>
  );
}
