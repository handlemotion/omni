import { IconCalendar } from "@/components/icons.ts";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";

/** Placeholder Calendar root page until full calendar and meeting recording ship on iOS. */
export default function CalendarHome() {
  return (
    <ModuleRoot module="calendar">
      <EmptyState icon={IconCalendar} title="No events" />
    </ModuleRoot>
  );
}
