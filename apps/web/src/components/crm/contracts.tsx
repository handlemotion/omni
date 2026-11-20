import { useQueryClient } from "@tanstack/react-query";
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
import { FileTrigger } from "@/components/ui/file-trigger";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { TextField } from "@/components/ui/text-field";
import {
  useCreateContract,
  useCrmContracts,
  useDeleteContract,
  useRecordFolder,
  useUpdateContract,
  useVoidContract,
} from "@/hooks/use-crm.ts";
import { useStorageList } from "@/hooks/use-storage.ts";
import { nextStatuses, type ContractChange } from "@/lib/crm-mutations.ts";
import type { CrmContract, CrmContractStatus } from "@/lib/crm.ts";
import { storageChanged } from "@/lib/storage.ts";
import { uploadFile } from "@/lib/storage-upload.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { storageErrorToast } from "@/components/storage/storage-errors";
import { ContractDetailsDialog } from "./contract-details.tsx";
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

type Owner = { companyId: string } | { dealId: string };
type Dialog = { kind: "new" } | { kind: "file" | "send" | "details"; contract: CrmContract } | null;

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
              onSend={() => setDialog({ kind: "send", contract })}
              onOpen={() => setDialog({ kind: "details", contract })}
            />
          ))}
        </ul>
      )}
      {dialog?.kind === "new" && (
        <NewContractDialog owner={props.owner} folderId={props.folderId} onClose={close} />
      )}
      {dialog?.kind === "send" && <SendContractDialog contract={dialog.contract} onClose={close} />}
      {dialog?.kind === "details" && (
        <ContractDetailsDialog
          contract={list.contracts.find((c) => c.id === dialog.contract.id) ?? dialog.contract}
          onSend={() => setDialog({ kind: "send", contract: dialog.contract })}
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
  const moves = contract.status === "sent" && contract.signing ? [] : nextStatuses(contract.status);
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
    ...moves.map((status) => ({
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

function useFolderFiles(folderId: string | null) {
  const list = useStorageList({ parentId: folderId ?? "" }, { enabled: !!folderId });
  return list.nodes.filter((node) => node.kind === "file");
}

function useContractUpload(owner: Owner) {
  const folder = useRecordFolder();
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const run = async (file: File, folderId: string | null) => {
    setPending(true);
    try {
      const parentId =
        folderId ??
        (
          await folder.mutateAsync(
            "dealId" in owner
              ? { kind: "deals", id: owner.dealId }
              : { kind: "companies", id: owner.companyId },
          )
        ).nodeId;
      const node = await uploadFile({
        file,
        place: { parentId },
        signal: new AbortController().signal,
        onOpened: () => {},
        onProgress: () => {},
        guard: () => {},
        confirm: async () => {},
      });
      await storageChanged(client);
      return { folderId: parentId, nodeId: node.id };
    } catch (error) {
      storageErrorToast(error, `“${file.name}” was not uploaded`);
      return null;
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

function FilePicker(props: {
  owner: Owner;
  folderId: string | null;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [folderId, setFolderId] = useState(props.folderId);
  const files = useFolderFiles(folderId);
  const upload = useContractUpload(props.owner);
  return (
    <div className="flex items-end gap-2">
      <Select
        className="min-w-0 flex-1"
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
      <FileTrigger
        acceptedFileTypes={["application/pdf"]}
        onSelect={(list) => {
          const file = list?.[0];
          if (!file) return;
          void upload.run(file, folderId).then((done) => {
            if (!done) return;
            setFolderId(done.folderId);
            props.onChange(done.nodeId);
          });
        }}
      >
        <Button intent="outline" isPending={upload.pending}>
          <IconUpload data-slot="icon" />
          Upload PDF
        </Button>
      </FileTrigger>
    </div>
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
