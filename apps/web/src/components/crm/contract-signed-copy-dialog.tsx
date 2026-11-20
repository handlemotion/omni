import { useState } from "react";
import { IconPlus, IconX } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { useSignedCopy } from "@/hooks/use-crm.ts";
import type { CrmContract } from "@/lib/crm.ts";
import { FilePicker, type Owner } from "./contract-file-picker.tsx";
import { useStartingSigners } from "./contract-send-dialog.tsx";
import { DayField } from "./day-field.tsx";
import { crmErrorToast } from "./crm-errors.ts";

interface Draft {
  key: number;
  name: string;
  email: string;
}

/** Signed outside Omni and still without its signed copy, or about to be. */
export const takesSignedCopy = (contract: CrmContract) =>
  !contract.signedNodeId && !(contract.status === "sent" && contract.signing);

const today = () => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

const middayOf = (day: string) => new Date(`${day}T12:00:00`).toISOString();

export function SignedCopyDialog(props: {
  owner: Owner;
  contract: CrmContract;
  folderId: string | null;
  onClose: () => void;
}) {
  const { loading, starting } = useStartingSigners(props.contract.dealId);
  if (loading) return null;
  return <SignedCopyForm {...props} starting={starting} />;
}

function SignedCopyForm(props: {
  owner: Owner;
  contract: CrmContract;
  folderId: string | null;
  starting: Draft[];
  onClose: () => void;
}) {
  const record = useSignedCopy();
  const { contract } = props;
  const [file, setFile] = useState<string | null>(null);
  const [day, setDay] = useState(contract.signedAt ? contract.signedAt.slice(0, 10) : today());
  const [drafts, setDrafts] = useState<Draft[]>(props.starting);
  const [next, setNext] = useState(props.starting.length + 1);
  const signers = drafts
    .map((draft) => ({ name: draft.name.trim(), email: draft.email.trim() || null }))
    .filter((signer) => signer.name || signer.email);
  const ready = Boolean(file && day) && signers.every((signer) => signer.name);
  const change = (key: number, patch: Partial<Draft>) =>
    setDrafts((all) => all.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  return (
    <Dialog size="md" isOpen onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">Signed copy of “{contract.title}”</DialogTitle>
      </DialogHeader>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready || !file) return;
          const keepsDay = contract.signedAt && contract.signedAt.slice(0, 10) === day;
          record.mutate(
            {
              id: contract.id,
              nodeId: file,
              signedAt: keepsDay ? contract.signedAt! : middayOf(day),
              signers,
            },
            {
              onSuccess: props.onClose,
              onError: (error) => crmErrorToast(error, "The signed copy was not saved"),
            },
          );
        }}
      >
        <DialogBody className="gap-4">
          <FilePicker
            label="Signed copy"
            pdfOnly
            owner={props.owner}
            folderId={props.folderId}
            value={file}
            onChange={setFile}
          />
          <DayField
            label="Signed on"
            isRequired
            max={today()}
            value={day}
            onChange={(next) => next && setDay(next)}
          />
          <ul className="flex flex-col gap-2" aria-label="Signed by">
            {drafts.map((draft, index) => (
              <li key={draft.key} className="flex flex-wrap items-center gap-2">
                <TextField
                  aria-label={`Name of signer ${index + 1}`}
                  value={draft.name}
                  onChange={(name) => change(draft.key, { name })}
                  className="min-w-0 flex-1 max-sm:basis-full"
                >
                  <Input placeholder="Name" autoComplete="off" />
                </TextField>
                <TextField
                  aria-label={`Email of signer ${index + 1}`}
                  type="email"
                  value={draft.email}
                  onChange={(email) => change(draft.key, { email })}
                  className="min-w-0 flex-1"
                >
                  <Input placeholder="name@company.com" autoComplete="off" />
                </TextField>
                <Button
                  intent="plain"
                  size="sq-xs"
                  aria-label={`Remove signer ${index + 1}`}
                  onPress={() => setDrafts((all) => all.filter((d) => d.key !== draft.key))}
                >
                  <IconX />
                </Button>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          <Button
            intent="outline"
            onPress={() => {
              setDrafts((all) => [...all, { key: next, name: "", email: "" }]);
              setNext(next + 1);
            }}
          >
            <IconPlus data-slot="icon" />
            Add signer
          </Button>
          <Button type="submit" isDisabled={!ready} isPending={record.isPending}>
            Save
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
