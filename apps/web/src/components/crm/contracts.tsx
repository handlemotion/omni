import { useState } from "react";
import { Button as Pressable } from "react-aria-components/Button";
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
  IconSignature,
  IconTrash,
  IconUpload,
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
import { TextField } from "@/components/ui/text-field";
import {
  useCreateContract,
  useCrmContracts,
  useDeleteContract,
  useUpdateContract,
  useVoidContract,
} from "@/hooks/use-crm.ts";
import { nextStatuses, type ContractChange } from "@/lib/crm-mutations.ts";
import type { CrmContract, CrmContractStatus } from "@/lib/crm.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { ContractDetailsDialog } from "./contract-details.tsx";
import { FilePicker, type Owner } from "./contract-file-picker.tsx";
import { SignedCopyDialog, takesSignedCopy } from "./contract-signed-copy-dialog.tsx";
import { SendContractDialog } from "./contract-send-dialog.tsx";
import { contractBadge, contractLine } from "./contract-status.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { NAME_MAX } from "./new-records.tsx";

const MOVE: Record<CrmContractStatus, { label: string; icon: SettingsRowMenuItem["icon"] }> = {
  draft: { label: "Back to draft", icon: IconArrowRotateClockwise },
  sent: { label: "Mark sent", icon: IconSend },
  signed: { label: "Mark signed", icon: IconCheck },
  ended: { label: "Mark ended", icon: IconCircleX },
};

type Dialog =
  | { kind: "new" }
  | { kind: "file" | "send" | "details" | "signed"; contract: CrmContract }
  | null;

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
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-background">
          {list.contracts.map((contract) => (
            <ContractRow
              key={contract.id}
              contract={contract}
              onAttach={() => setDialog({ kind: "file", contract })}
              onSend={() => setDialog({ kind: "send", contract })}
              onSigned={() => setDialog({ kind: "signed", contract })}
              onOpen={() => setDialog({ kind: "details", contract })}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === "new" && (
        <NewContractDialog owner={props.owner} folderId={props.folderId} onClose={close} />
      )}
      {dialog?.kind === "send" && <SendContractDialog contract={dialog.contract} onClose={close} />}
      {dialog?.kind === "signed" && (
        <SignedCopyDialog
          owner={props.owner}
          contract={dialog.contract}
          folderId={props.folderId}
          onClose={close}
        />
      )}
      {dialog?.kind === "details" && (
        <ContractDetailsDialog
          contract={list.contracts.find((c) => c.id === dialog.contract.id) ?? dialog.contract}
          onSend={() => setDialog({ kind: "send", contract: dialog.contract })}
          onSigned={() => setDialog({ kind: "signed", contract: dialog.contract })}
          onClose={close}
        />
      )}
      {dialog?.kind === "file" && (
        <AttachFileDialog
          owner={props.owner}
          contract={dialog.contract}
          folderId={props.folderId}
          onClose={close}
        />
      )}
    </div>
  );
}

function ContractRow(props: {
  contract: CrmContract;
  onAttach: () => void;
  onSend: () => void;
  onSigned: () => void;
  onOpen: () => void;
}) {
  const { contract } = props;
  const update = useUpdateContract();
  const remove = useDeleteContract();
  const voiding = useVoidContract();
  const locked = contract.status === "signed" || contract.status === "ended";
  const out = contract.status === "sent" && contract.signing?.status === "sent";
  const fileId = contract.documentNodeId;
  const signedId = contract.signedNodeId ?? contract.signing?.sealedNodeId;
  const change = (patch: ContractChange, fallback: string) =>
    update.mutate(
      { id: contract.id, ...patch },
      { onError: (error) => crmErrorToast(error, fallback) },
    );
  const moves = (
    contract.status === "sent" && contract.signing ? [] : nextStatuses(contract.status)
  ).filter((status) => status !== "signed");
  const items: SettingsRowMenuItem[] = [
    ...(contract.status === "draft" && fileId
      ? [{ icon: IconSignature, label: "Send for signature", onAction: props.onSend }]
      : []),
    ...(out
      ? [
          {
            icon: IconCircleX,
            label: "Void",
            onAction: () =>
              voiding.mutate(contract.id, {
                onError: (error) => crmErrorToast(error, "The contract was not voided"),
              }),
          },
        ]
      : []),
    ...(takesSignedCopy(contract)
      ? [{ icon: IconUpload, label: "Upload signed copy", onAction: props.onSigned }]
      : []),
    ...moves.map((status) => ({
      ...MOVE[status],
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
    ...(signedId
      ? [
          {
            icon: IconDownload,
            label: "Download signed copy",
            onAction: () => window.location.assign(storageFileUrl(signedId)),
          },
        ]
      : []),
    ...(locked || out
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
  const line = contractLine(contract);
  const badge = contractBadge(contract);
  const Icon = locked ? IconFileLock : IconFileText;
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <Icon
        aria-label={locked ? "File locked" : undefined}
        className="size-icon shrink-0 text-muted-foreground"
      />
      <Pressable
        className="flex min-w-0 flex-1 cursor-default flex-col items-start gap-0.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPress={props.onOpen}
      >
        <span className="w-full truncate text-sm">{contract.title}</span>
        {line && (
          <span className="w-full truncate text-xs/4 text-muted-foreground tabular-nums">
            {line}
          </span>
        )}
      </Pressable>
      <Badge intent={badge.intent}>{badge.label}</Badge>
      <SettingsRowMenu label={`Actions for ${contract.title}`} items={items} />
    </li>
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
      <FilePicker owner={props.owner} folderId={props.folderId} value={file} onChange={setFile} />
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
  owner: Owner;
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
      <FilePicker owner={props.owner} folderId={props.folderId} value={file} onChange={setFile} />
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
