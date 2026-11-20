import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { IconUpload } from "@/components/icons/central";
import { storageErrorToast } from "@/components/storage/storage-errors";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/field";
import { FileTrigger } from "@/components/ui/file-trigger";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useRecordFolder } from "@/hooks/use-crm.ts";
import { useStorageList } from "@/hooks/use-storage.ts";
import { storageChanged } from "@/lib/storage.ts";
import { uploadFile } from "@/lib/storage-upload.ts";

/** The record a contract is on. */
export type Owner = { companyId: string } | { dealId: string };

function useFolderFiles(folderId: string | null, pdfOnly: boolean) {
  const list = useStorageList({ parentId: folderId ?? "" }, { enabled: !!folderId });
  return list.nodes.filter(
    (node) => node.kind === "file" && (!pdfOnly || node.mimeType === "application/pdf"),
  );
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

/**
 * A file from the record's folder, or a PDF uploaded into it (making the folder first). With no
 * file in the folder yet, only the upload button shows.
 */
export function FilePicker(props: {
  label?: string;
  /** Only PDFs from the folder, as for a signed copy. */
  pdfOnly?: boolean;
  owner: Owner;
  folderId: string | null;
  value: string | null;
  /** The chosen file's id, and its name when one is chosen. */
  onChange: (id: string | null, name: string | null) => void;
}) {
  const [folderId, setFolderId] = useState(props.folderId);
  const files = useFolderFiles(folderId, !!props.pdfOnly);
  const upload = useContractUpload(props.owner);
  const button = (
    <FileTrigger
      acceptedFileTypes={["application/pdf"]}
      onSelect={(list) => {
        const file = list?.[0];
        if (!file) return;
        void upload.run(file, folderId).then((done) => {
          if (!done) return;
          setFolderId(done.folderId);
          props.onChange(done.nodeId, file.name);
        });
      }}
    >
      <Button
        intent="outline"
        isPending={upload.pending}
        className={files.length ? "" : "self-start"}
      >
        <IconUpload data-slot="icon" />
        Upload PDF
      </Button>
    </FileTrigger>
  );
  if (!files.length) return button;
  return (
    <div className="flex items-end gap-2">
      <Select
        className="min-w-0 flex-1"
        value={props.value}
        onChange={(id) => props.onChange(id, files.find((file) => file.id === id)?.name ?? null)}
        placeholder="None"
      >
        <Label>{props.label ?? "File"}</Label>
        <SelectTrigger />
        <SelectContent items={files}>
          {(file) => (
            <SelectItem id={file.id} textValue={file.name}>
              {file.name}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      {button}
    </div>
  );
}
