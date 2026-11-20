import { useState } from "react";
import { Skeleton } from "skullet/react";
import { IconDownload, IconPlus, IconX } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
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
import {
  useSendForSignature,
  useStorageSignatures,
  useVoidSignature,
} from "@/hooks/use-storage-signing.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import type { StorageSignatureRequest } from "@/lib/storage-signing.ts";
import { storageErrorToast } from "./storage-errors.ts";
import { downloadFile } from "@/lib/download.ts";

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const STATUS: Record<
  StorageSignatureRequest["status"],
  { label: string; intent: "info" | "success" | "secondary" }
> = {
  sent: { label: "Out for signature", intent: "info" },
  completed: { label: "Signed", intent: "success" },
  voided: { label: "Voided", intent: "secondary" },
};

const SAMPLE: StorageSignatureRequest[] = [];

export function SignaturesDialog(props: { node: StorageNode; onClose: () => void }) {
  const { node } = props;
  const requests = useStorageSignatures(node.id);
  return (
    <Dialog size="md" isOpen onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">Signatures for “{node.name}”</DialogTitle>
      </DialogHeader>
      <Skeleton
        id="storage-signatures"
        data={requests.data?.requests}
        sample={SAMPLE}
        label="Loading signatures"
      >
        {(state) =>
          !state.some((request) => request.status === "sent") ? (
            <SendForm node={node} requests={state} />
          ) : (
            <DialogBody className="gap-5">
              {state.map((request) => (
                <RequestGroup key={request.id} request={request} />
              ))}
            </DialogBody>
          )
        }
      </Skeleton>
    </Dialog>
  );
}

interface Draft {
  key: number;
  name: string;
  email: string;
}

function SendForm(props: { node: StorageNode; requests: StorageSignatureRequest[] }) {
  const send = useSendForSignature();
  const [next, setNext] = useState(1);
  const [drafts, setDrafts] = useState<Draft[]>([{ key: 0, name: "", email: "" }]);
  const signers = drafts
    .map((draft) => ({ name: draft.name.trim(), email: draft.email.trim() }))
    .filter((signer) => signer.name || signer.email);
  const ready = signers.length > 0 && signers.every((signer) => signer.name && signer.email);
  const change = (key: number, patch: Partial<Draft>) =>
    setDrafts((all) => all.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        send.mutate(
          { id: props.node.id, signers },
          { onError: (error) => storageErrorToast(error, "It was not sent") },
        );
      }}
    >
      <DialogBody className="gap-5">
        <ul className="flex flex-col gap-2">
          {drafts.map((draft, index) => (
            <li key={draft.key} className="flex flex-wrap items-center gap-2">
              <TextField
                aria-label={`Name of signer ${index + 1}`}
                value={draft.name}
                onChange={(name) => change(draft.key, { name })}
                autoFocus={index === 0}
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
                isDisabled={drafts.length === 1}
                onPress={() => setDrafts((all) => all.filter((d) => d.key !== draft.key))}
              >
                <IconX />
              </Button>
            </li>
          ))}
        </ul>
        {props.requests.map((request) => (
          <RequestGroup key={request.id} request={request} />
        ))}
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
        <Button type="submit" isDisabled={!ready} isPending={send.isPending}>
          Send
        </Button>
      </DialogFooter>
    </form>
  );
}

function RequestGroup({ request }: { request: StorageSignatureRequest }) {
  const voiding = useVoidSignature();
  const status = STATUS[request.status];
  return (
    <section className="flex flex-col gap-2">
      <header className="flex min-h-8 items-center gap-2">
        <h3 className="flex-1 text-sm text-muted-foreground tabular-nums">
          {WHEN.format(new Date(request.createdAt))}
        </h3>
        <Badge intent={status.intent}>{status.label}</Badge>
        {request.status === "sent" && (
          <Button
            intent="outline"
            size="sm"
            isPending={voiding.isPending}
            onPress={() =>
              voiding.mutate(
                { requestId: request.id, nodeId: request.nodeId },
                { onError: (error) => storageErrorToast(error, "It was not voided") },
              )
            }
          >
            Void
          </Button>
        )}
        {request.sealedNodeId && (
          <Button
            intent="outline"
            size="sm"
            onPress={() => downloadFile(storageFileUrl(request.sealedNodeId!))}
          >
            <IconDownload data-slot="icon" />
            Signed copy
          </Button>
        )}
      </header>
      <ul className="flex flex-col gap-2">
        {request.signers.map((signer) => (
          <li key={signer.email} className="flex min-h-10 items-center gap-2.5">
            <Avatar size="sm" initials={signer.name.slice(0, 1).toUpperCase()} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm">{signer.name}</span>
              <span className="truncate text-xs text-muted-foreground">{signer.email}</span>
            </span>
            {signer.signedAt && (
              <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
                {WHEN.format(new Date(signer.signedAt))}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
