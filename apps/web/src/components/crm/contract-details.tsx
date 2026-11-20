import { IconDownload, IconSignature } from "@/components/icons/central";
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
import { useVoidContract } from "@/hooks/use-crm.ts";
import type { CrmContract } from "@/lib/crm.ts";
import { downloadFile } from "@/lib/download.ts";
import { storageFileUrl } from "@/lib/urls.ts";
import { contractBadge, contractDates } from "./contract-status.ts";
import { crmErrorToast } from "./crm-errors.ts";

const WHEN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type Signer = NonNullable<CrmContract["signing"]>["signers"][number];

function signerBadge(signer: Signer) {
  if (signer.signedAt) return <Badge intent="success">Signed</Badge>;
  if (signer.viewedAt) return <Badge intent="info">Viewed</Badge>;
  return <Badge intent="secondary">Waiting</Badge>;
}

export function ContractDetailsDialog(props: {
  contract: CrmContract;
  onSend: () => void;
  onClose: () => void;
}) {
  const { contract } = props;
  const voiding = useVoidContract();
  const badge = contractBadge(contract);
  const signing = contract.signing;
  const dates = contractDates(contract);
  const signedId = contract.signedNodeId ?? signing?.sealedNodeId;
  const canSend = contract.status === "draft" && Boolean(contract.documentNodeId);
  const out = contract.status === "sent" && signing?.status === "sent";
  return (
    <Dialog size="md" isOpen onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogHeader>
        <div className="flex items-center gap-2">
          <DialogTitle className="min-w-0 flex-1 truncate">{contract.title}</DialogTitle>
          <Badge intent={badge.intent}>{badge.label}</Badge>
        </div>
      </DialogHeader>
      <DialogBody className="gap-5">
        {dates && <p className="text-sm text-muted-foreground tabular-nums">{dates}</p>}
        {signing && (
          <ul className="flex flex-col gap-2" aria-label="Signers">
            {signing.signers.map((signer) => (
              <li key={signer.email} className="flex min-h-10 items-center gap-2.5">
                <Avatar size="sm" initials={signer.name.slice(0, 1).toUpperCase()} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{signer.name}</span>
                  <span className="truncate text-xs text-muted-foreground">{signer.email}</span>
                </span>
                {signer.signedAt && (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {WHEN.format(new Date(signer.signedAt))}
                  </span>
                )}
                {signerBadge(signer)}
              </li>
            ))}
          </ul>
        )}
      </DialogBody>
      <DialogFooter>
        {contract.documentNodeId && (
          <Button
            intent="outline"
            onPress={() => downloadFile(storageFileUrl(contract.documentNodeId!))}
          >
            <IconDownload data-slot="icon" />
            Document
          </Button>
        )}
        {signedId && (
          <Button intent="outline" onPress={() => downloadFile(storageFileUrl(signedId))}>
            <IconDownload data-slot="icon" />
            Signed copy
          </Button>
        )}
        {out && (
          <Button
            intent="outline"
            isPending={voiding.isPending}
            onPress={() =>
              voiding.mutate(contract.id, {
                onError: (error) => crmErrorToast(error, "The contract was not voided"),
              })
            }
          >
            Void
          </Button>
        )}
        {canSend && (
          <Button onPress={props.onSend}>
            <IconSignature data-slot="icon" />
            Send for signature
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
