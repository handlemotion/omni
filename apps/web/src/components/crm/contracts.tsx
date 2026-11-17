import { useState } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { EmptyState } from "@/components/empty/empty-state";
import {
  IconArrowRotateClockwise,
  IconCheck,
  IconCircleX,
  IconDownload,
  IconFileLock,
  IconFileText,
  IconPaperclip,
  IconPlus,
  IconSend,
  IconTrash,
} from "@/components/icons/central";
import { SettingsFormDialog } from "@/components/settings/kit/settings-stacked-dialog";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import {
  useCreateContract,
  useCrmContracts,
  useDeleteContract,
  useUpdateContract,
} from "@/hooks/use-crm.ts";
import { useStorageList } from "@/hooks/use-storage.ts";
import { nextStatuses, type ContractChange } from "@/lib/crm-mutations.ts";
import type { CrmContract, CrmContractStatus } from "@/lib/crm.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { NAME_MAX } from "./new-records.tsx";
import { DAY } from "./record-list.tsx";

const STATUS: Record<
  CrmContractStatus,
  { label: string; intent: "secondary" | "info" | "success" | "outline" }
> = {
  draft: { label: "Draft", intent: "secondary" },
  sent: { label: "Sent", intent: "info" },
  signed: { label: "Signed", intent: "success" },
  ended: { label: "Ended", intent: "outline" },
};

const MOVE: Record<CrmContractStatus, { label: string; icon: SettingsRowMenuItem["icon"] }> = {
  draft: { label: "Back to draft", icon: IconArrowRotateClockwise },
  sent: { label: "Mark sent", icon: IconSend },
  signed: { label: "Mark signed", icon: IconCheck },
  ended: { label: "Mark ended", icon: IconCircleX },
};

const day = (date: string | null) => (date ? DAY.format(new Date(`${date}T00:00:00`)) : null);

type Owner = { companyId: string } | { dealId: string };
type Dialog = { kind: "new" } | { kind: "file"; contract: CrmContract } | null;

export function Contracts(props: { owner: Owner; folderId: string | null }) {
  const where =
    "dealId" in props.owner ? { deal: props.owner.dealId } : { company: props.owner.companyId };
  const list = useCrmContracts(where);
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button size="sm" onPress={() => setDialog({ kind: "new" })}>
          <IconPlus />
          New contract
        </Button>
      </div>
      {list.isPending ? (
        <Skeleton loading label="Loading contracts" skeleton={<ContractBones />}>
          {null}
        </Skeleton>
      ) : list.isError ? (
        <Button
          size="sm"
          intent="outline"
          className="self-start"
          onPress={() => void list.refetch()}
        >
          Try again
        </Button>
      ) : list.contracts.length === 0 ? (
        <EmptyState figure="cabinet" title="No contracts yet" />
      ) : (
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-background shadow-(--shadow-raised)">
          {list.contracts.map((contract) => (
            <ContractRow
              key={contract.id}
              contract={contract}
              onAttach={() => setDialog({ kind: "file", contract })}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === "new" && (
        <NewContractDialog owner={props.owner} folderId={props.folderId} onClose={close} />
      )}
      {dialog?.kind === "file" && (
        <AttachFileDialog contract={dialog.contract} folderId={props.folderId} onClose={close} />
      )}
    </div>
  );
}

function ContractRow(props: { contract: CrmContract; onAttach: () => void }) {
  const { contract } = props;
  const update = useUpdateContract();
  const remove = useDeleteContract();
  const locked = contract.status === "signed" || contract.status === "ended";
  const fileId = contract.documentNodeId;
  const change = (patch: ContractChange, fallback: string) =>
    update.mutate(
      { id: contract.id, ...patch },
      { onError: (error) => crmErrorToast(error, fallback) },
    );
  const items: SettingsRowMenuItem[] = [
    ...nextStatuses(contract.status).map((status) => ({
      ...MOVE[status],
      disabled: status === "signed" && !contract.documentNodeId,
      onAction: () => change({ status }, "The contract was not changed"),
    })),
    ...(contract.status === "draft"
      ? [{ icon: IconPaperclip, label: "Choose file", onAction: props.onAttach }]
      : []),
    ...(fileId
      ? [
          {
            icon: IconDownload,
            label: "Download",
            onAction: () => window.location.assign(storageFileUrl(fileId)),
          },
        ]
      : []),
    ...(locked
      ? []
      : [
          {
            icon: IconTrash,
            label: "Delete",
            danger: true,
            onAction: () =>
              remove.mutate(contract.id, {
                onError: (error) => crmErrorToast(error, "The contract was not deleted"),
              }),
          },
        ]),
  ];
  const dates = [
    contract.effectiveOn && `From ${day(contract.effectiveOn)}`,
    contract.expiresOn && `until ${day(contract.expiresOn)}`,
  ].filter(Boolean);
  const Icon = locked ? IconFileLock : IconFileText;
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <Icon
        aria-label={locked ? "File locked" : undefined}
        className="size-icon shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm">{contract.title}</span>
        {dates.length > 0 && (
          <span className="truncate text-xs/4 text-muted-foreground tabular-nums">
            {dates.join(" ")}
          </span>
        )}
      </div>
      <Badge intent={STATUS[contract.status].intent}>{STATUS[contract.status].label}</Badge>
      <SettingsRowMenu label={`Actions for ${contract.title}`} items={items} />
    </li>
  );
}

function useFolderFiles(folderId: string | null) {
  const list = useStorageList({ parentId: folderId ?? "" }, { enabled: !!folderId });
  return list.nodes.filter((node) => node.kind === "file");
}

function FilePicker(props: {
  folderId: string | null;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const files = useFolderFiles(props.folderId);
  return (
    <Select
      value={props.value}
      onChange={(id) => props.onChange(id)}
      placeholder="None"
      isDisabled={!files.length}
    >
      <Label>File</Label>
      <SelectTrigger />
      <SelectContent items={files}>
        {(file) => (
          <SelectItem id={file.id} textValue={file.name}>
            {file.name}
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function NewContractDialog(props: { owner: Owner; folderId: string | null; onClose: () => void }) {
  const create = useCreateContract();
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<string | null>(null);
  const [effectiveOn, setEffectiveOn] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="New contract"
      action="Create draft"
      disabled={!title.trim()}
      saving={create.isPending}
      onSubmit={() =>
        create.mutate(
          {
            ...props.owner,
            title: title.trim(),
            documentNodeId: file,
            effectiveOn: effectiveOn || null,
            expiresOn: expiresOn || null,
          },
          {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "The contract was not created"),
          },
        )
      }
    >
      <TextField isRequired autoFocus maxLength={NAME_MAX} value={title} onChange={setTitle}>
        <Label>Title</Label>
        <Input autoComplete="off" />
      </TextField>
      <FilePicker folderId={props.folderId} value={file} onChange={setFile} />
      <div className="grid grid-cols-2 gap-3">
        <TextField type="date" value={effectiveOn} onChange={setEffectiveOn}>
          <Label>Starts</Label>
          <Input />
        </TextField>
        <TextField type="date" value={expiresOn} onChange={setExpiresOn}>
          <Label>Ends</Label>
          <Input />
        </TextField>
      </div>
    </SettingsFormDialog>
  );
}

function AttachFileDialog(props: {
  contract: CrmContract;
  folderId: string | null;
  onClose: () => void;
}) {
  const update = useUpdateContract();
  const [file, setFile] = useState<string | null>(props.contract.documentNodeId);
  return (
    <SettingsFormDialog
      isOpen
      onOpenChange={(open) => !open && props.onClose()}
      title="Choose file"
      action="Save"
      disabled={!file || file === props.contract.documentNodeId}
      saving={update.isPending}
      onSubmit={() =>
        update.mutate(
          { id: props.contract.id, documentNodeId: file },
          {
            onSuccess: props.onClose,
            onError: (error) => crmErrorToast(error, "The file was not attached"),
          },
        )
      }
    >
      <FilePicker folderId={props.folderId} value={file} onChange={setFile} />
    </SettingsFormDialog>
  );
}

function ContractBones() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 3 }, (_, i) => (
        <SkeletonBox key={i} width="100%" height={56} radius="var(--radius-xl)" />
      ))}
    </div>
  );
}
