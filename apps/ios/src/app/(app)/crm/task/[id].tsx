import { useLocalSearchParams } from "expo-router";
import { TaskScreen } from "@/components/crm/task-view.tsx";

/** A task: its title and notes, who has it, when it's due and the record it's on. */
export default function Task() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TaskScreen id={id} />;
}
