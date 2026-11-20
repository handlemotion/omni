import { useState } from "react";
import { IconTrash, IconUserCog } from "@/components/icons/central";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import { useGrantAccess, useProjectAccess, useRevokeAccess } from "@/hooks/use-crm-project.ts";
import { PROJECT_SCOPES, type CrmProjectAccess, type CrmProjectScope } from "@/lib/crm-project.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { DetailSection, NoneRow } from "./record-layout.tsx";
import { AddButton, RowWithMenu } from "./record-sections.tsx";

const scopeLabel = (scope: CrmProjectScope) =>
  PROJECT_SCOPES.find((one) => one.id === scope)?.label ?? scope;

/** The people outside the team on a project: freelancers and clients, each with a menu. */
export function AccessSection(props: { dealId: string }) {
  const access = useProjectAccess(props.dealId);
  const [adding, setAdding] = useState(false);
  const rows = access.data ?? [];
  return (
    <DetailSection
      title="Access"
      action={<AddButton label="Add someone" onPress={() => setAdding(true)} />}
    >
      {rows.length ? (
        rows.map((row) => <AccessRow key={row.email} dealId={props.dealId} row={row} />)
      ) : (
        <NoneRow />
      )}
      {adding && <GrantAccessDialog dealId={props.dealId} onClose={() => setAdding(false)} />}
    </DetailSection>
  );
}

function AccessRow(props: { dealId: string; row: CrmProjectAccess }) {
  const grant = useGrantAccess();
  const revoke = useRevokeAccess();
  const { row, dealId } = props;
  const other: CrmProjectScope = row.scope === "client" ? "freelancer" : "client";
  return (
    <RowWithMenu
      label={row.name || row.email}
      actions={[
        {
          id: "scope",
          label: `Make ${scopeLabel(other).toLowerCase()}`,
          icon: <IconUserCog data-slot="icon" />,
          onAction: () =>
            grant.mutate(
              { dealId, email: row.email, scope: other },
              { onError: (error) => crmErrorToast(error, "Their access was not changed") },
            ),
        },
        {
          id: "remove",
          label: "Remove from project",
          icon: <IconTrash data-slot="icon" />,
          danger: true,
          onAction: () =>
            revoke.mutate(
              { dealId, email: row.email },
              { onError: (error) => crmErrorToast(error, "They were not removed") },
            ),
        },
      ]}
    >
      <span className="flex h-8 min-w-0 items-center gap-2 text-sm">
        <span className="truncate" title={row.email}>
          {row.name || row.email}
        </span>
        <Badge intent="secondary" className="shrink-0">
          {scopeLabel(row.scope)}
        </Badge>
      </span>
    </RowWithMenu>
  );
}

function GrantAccessDialog(props: { dealId: string; onClose: () => void }) {
  const grant = useGrantAccess();
  const [email, setEmail] = useState("");
  const [scope, setScope] = useState<CrmProjectScope>("client");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Add to project"
      action="Add"
      disabled={!email.trim()}
      saving={grant.isPending}
      onSubmit={() =>
        grant.mutate(
          { dealId: props.dealId, email: email.trim(), scope },
          {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "They were not added"),
          },
        )
      }
    >
      <TextField
        isRequired
        autoFocus
        type="email"
        maxLength={320}
        value={email}
        onChange={setEmail}
      >
        <Label>Email</Label>
        <Input autoComplete="off" />
      </TextField>
      <Select value={scope} onChange={(id) => id && setScope(id as CrmProjectScope)}>
        <Label>Access</Label>
        <SelectTrigger />
        <SelectContent items={PROJECT_SCOPES}>
          {(item) => (
            <SelectItem id={item.id} textValue={item.label}>
              {item.label}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
    </SettingsFormDialog>
  );
}
