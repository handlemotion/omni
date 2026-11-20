import type { ReactNode } from "react";
import { byAddress } from "@/components/avatar/sender-avatar";
import { IconEllipsis, IconPlus, IconStar, IconTrash } from "@/components/icons/central";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useCrmStages, useRemoveDomain, useUpdatePerson } from "@/hooks/use-crm.ts";
import type { CrmDeal, CrmPerson } from "@/lib/crm.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { DetailSection, NoneRow, RelatedRow } from "./record-layout.tsx";

export function AddButton(props: { label: string; onPress: () => void }) {
  return (
    <Button intent="plain" size="sq-xs" aria-label={props.label} onPress={props.onPress}>
      <IconPlus />
    </Button>
  );
}

interface RowAction {
  id: string;
  label: string;
  icon: ReactNode;
  danger?: boolean;
  onAction: () => void;
}

export function RowWithMenu(props: { label: string; actions: RowAction[]; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1">
      <div className="flex min-w-0 flex-1 flex-col">{props.children}</div>
      <MenuTrigger>
        <Button intent="plain" size="sq-xs" aria-label={`${props.label} actions`}>
          <IconEllipsis />
        </Button>
        <Menu placement="bottom end" aria-label={props.label}>
          {props.actions.map((action) => (
            <MenuItem
              key={action.id}
              id={action.id}
              textValue={action.label}
              intent={action.danger ? "danger" : undefined}
              onAction={action.onAction}
            >
              {action.icon}
              <MenuLabel>{action.label}</MenuLabel>
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
    </div>
  );
}

const TRASH = <IconTrash data-slot="icon" />;

export function DomainsSection(props: { companyId: string; domains: string[]; onAdd: () => void }) {
  const remove = useRemoveDomain();
  return (
    <DetailSection title="Domains" action={<AddButton label="Add domain" onPress={props.onAdd} />}>
      {props.domains.length ? (
        props.domains.map((domain) => (
          <RowWithMenu
            key={domain}
            label={domain}
            actions={[
              {
                id: "remove",
                label: "Remove domain",
                icon: TRASH,
                danger: true,
                onAction: () =>
                  remove.mutate(
                    { id: props.companyId, domain },
                    { onError: (error) => crmErrorToast(error, "The domain was not removed") },
                  ),
              },
            ]}
          >
            <span className="flex h-8 items-center truncate text-sm">{domain}</span>
          </RowWithMenu>
        ))
      ) : (
        <NoneRow />
      )}
    </DetailSection>
  );
}

/** A person's addresses: the primary first, each with its own menu. */
export function AddressesSection(props: { person: CrmPerson; onAdd: () => void }) {
  const update = useUpdatePerson();
  const { person } = props;
  const change = (addresses: { remove?: string[]; primary?: string }) =>
    update.mutate(
      { id: person.id, addresses },
      { onError: (error) => crmErrorToast(error, "The addresses were not changed") },
    );
  return (
    <DetailSection title="Email" action={<AddButton label="Add address" onPress={props.onAdd} />}>
      {person.addresses.map(({ address, isPrimary }) => (
        <RowWithMenu
          key={address}
          label={address}
          actions={[
            ...(isPrimary
              ? []
              : [
                  {
                    id: "primary",
                    label: "Make primary",
                    icon: <IconStar data-slot="icon" />,
                    onAction: () => change({ primary: address }),
                  },
                ]),
            ...(person.addresses.length > 1
              ? [
                  {
                    id: "remove",
                    label: "Remove address",
                    icon: TRASH,
                    danger: true,
                    onAction: () => change({ remove: [address] }),
                  },
                ]
              : []),
          ]}
        >
          <span className="flex h-8 min-w-0 items-center gap-2 text-sm">
            <span className="truncate">{address}</span>
            {isPrimary && person.addresses.length > 1 && (
              <Badge intent="secondary" className="shrink-0">
                Primary
              </Badge>
            )}
          </span>
        </RowWithMenu>
      ))}
    </DetailSection>
  );
}

/** People on a company or a deal; on a deal each can be taken off. */
export function PeopleSection(props: {
  people: CrmPerson[];
  onAdd: () => void;
  onRemove?: (personId: string) => void;
}) {
  const { onRemove } = props;
  return (
    <DetailSection title="People" action={<AddButton label="Add person" onPress={props.onAdd} />}>
      {props.people.length ? (
        props.people.map((person) => {
          const row = (
            <RelatedRow
              key={person.id}
              kind="people"
              id={person.id}
              name={person.name}
              who={byAddress(person.addresses[0]?.address)}
              meta={person.jobTitle}
            />
          );
          if (!onRemove) return row;
          return (
            <RowWithMenu
              key={person.id}
              label={person.name}
              actions={[
                {
                  id: "remove",
                  label: "Remove from deal",
                  icon: TRASH,
                  danger: true,
                  onAction: () => onRemove(person.id),
                },
              ]}
            >
              {row}
            </RowWithMenu>
          );
        })
      ) : (
        <NoneRow />
      )}
    </DetailSection>
  );
}

export function DealsSection(props: { deals: CrmDeal[]; onAdd?: () => void }) {
  const stages = useCrmStages().data ?? [];
  return (
    <DetailSection
      title="Deals"
      action={props.onAdd && <AddButton label="Add deal" onPress={props.onAdd} />}
    >
      {props.deals.length ? (
        props.deals.map((deal) => (
          <RelatedRow
            key={deal.id}
            kind="deals"
            id={deal.id}
            name={deal.name}
            meta={stages.find((stage) => stage.id === deal.stageId)?.name}
          />
        ))
      ) : (
        <NoneRow />
      )}
    </DetailSection>
  );
}
