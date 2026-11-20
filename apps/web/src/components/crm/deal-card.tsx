import { Link } from "@/components/ui/link";
import { useCrmCompanyIndex, useOwners } from "@/hooks/use-crm.ts";
import { useFreelancer } from "@/hooks/use-freelancer.ts";
import { useWorkspacePaths } from "@/hooks/use-workspaces.ts";
import { formatMoney, type CrmDeal } from "@/lib/crm.ts";
import { calendarDay } from "./list-columns.tsx";
import { MemberAvatar } from "./member-avatar.tsx";
import { RecordMark } from "./record-list.tsx";

const CARD =
  "flex items-start gap-3 rounded-xl border bg-background p-3 text-start transition-colors duration-150 ease-out";

/** A deal on the board: its company's logo, its name, value and close date, and its owner. */
export function DealCard({ deal }: { deal: CrmDeal }) {
  const { href: inWorkspace } = useWorkspacePaths();
  return (
    <Link
      href={inWorkspace(`/crm/deals/${encodeURIComponent(deal.id)}`)}
      className={`${CARD} hover:border-muted-foreground/30`}
    >
      <DealFace deal={deal} />
    </Link>
  );
}

/** The card the pointer carries while a deal moves between stages. */
export function LiftedDealCard({ deal }: { deal: CrmDeal }) {
  return (
    <div className={`${CARD} cursor-grabbing border-muted-foreground/30`}>
      <DealFace deal={deal} />
    </div>
  );
}

function DealFace({ deal }: { deal: CrmDeal }) {
  const company = useCrmCompanyIndex().get(deal.companyId ?? "");
  const owner = useOwners().find((member) => member.id === deal.ownerMemberId);
  const value = useFreelancer() ? null : formatMoney(deal.valueMinor, deal.valueCurrency);
  const closes = calendarDay(deal.expectedCloseOn);
  return (
    <>
      <span className="flex h-5 shrink-0 items-center">
        <RecordMark
          name={company?.name ?? deal.name}
          square
          size={20}
          who={company?.domain ? { domain: company.domain } : null}
        />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 text-sm/5 text-foreground">{deal.name}</span>
        {(value || closes) && (
          <span className="flex flex-wrap gap-x-3 text-sm/5 text-muted-foreground tabular-nums">
            {value && <span>{value}</span>}
            {closes && <span>Closes {closes}</span>}
          </span>
        )}
      </span>
      {owner && (
        <span className="flex h-5 shrink-0 items-center" title={owner.name}>
          <MemberAvatar name={owner.name} image={owner.image} size={20} />
        </span>
      )}
    </>
  );
}
