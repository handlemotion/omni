import { IconMicrophone } from "@/components/icons.ts";
import { ModuleRoot } from "@/components/shell/module-root.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";

/** Placeholder Meetings root page until meeting recording ships on iOS. */
export default function MeetingsHome() {
  return (
    <ModuleRoot module="meetings">
      <EmptyState icon={IconMicrophone} title="No meetings" />
    </ModuleRoot>
  );
}
