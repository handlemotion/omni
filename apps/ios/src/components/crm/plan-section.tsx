import { View } from "react-native";
import { IconChecklist, IconFlag, IconUsers } from "@/components/icons.ts";
import { ItemRow } from "@/components/ui/item-row.tsx";
import { SectionHeading } from "@/components/ui/section-heading.tsx";
import { dayText } from "@/lib/crm.ts";
import {
  deliverableStatus,
  milestoneStatus,
  usePlan,
  useProjectAccess,
  type CrmDeliverable,
} from "@/lib/crm-project.ts";

const deliverableDetail = (deliverable: CrmDeliverable) =>
  deliverable.status === "changes_requested" && deliverable.reviewNote
    ? deliverable.reviewNote
    : dayText(deliverable.dueOn);

function Deliverables({ items }: { items: CrmDeliverable[] }) {
  return items.map((deliverable) => (
    <ItemRow
      key={deliverable.id}
      icon={IconChecklist}
      title={deliverable.title}
      detail={deliverableDetail(deliverable)}
      trailing={deliverableStatus(deliverable)}
    />
  ));
}

/** A project's plan: each milestone with its deliverables under it, then those with none. */
export function PlanSection({ dealId }: { dealId: string }) {
  const plan = usePlan(dealId).data;
  if (!plan || (!plan.milestones.length && !plan.deliverables.length)) return null;
  const loose = plan.deliverables.filter((d) => !d.milestoneId);
  return (
    <View>
      <SectionHeading label="Plan" />
      {plan.milestones.map((milestone) => (
        <View key={milestone.id}>
          <ItemRow
            icon={IconFlag}
            title={milestone.title}
            detail={dayText(milestone.targetOn)}
            trailing={milestoneStatus(milestone)}
          />
          <Deliverables items={plan.deliverables.filter((d) => d.milestoneId === milestone.id)} />
        </View>
      ))}
      <Deliverables items={loose} />
    </View>
  );
}

/** The people outside the team on a project: freelancers and clients. */
export function AccessSection({ dealId }: { dealId: string }) {
  const access = useProjectAccess(dealId).data ?? [];
  if (!access.length) return null;
  return (
    <View>
      <SectionHeading label="Access" />
      {access.map((person) => (
        <ItemRow
          key={person.email}
          icon={IconUsers}
          title={person.name || person.email}
          detail={person.name ? person.email : null}
          trailing={person.scope === "client" ? "Client" : "Freelancer"}
        />
      ))}
    </View>
  );
}
