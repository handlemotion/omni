import { useQuery } from "@tanstack/react-query";
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
import { useSendContract } from "@/hooks/use-crm.ts";
import { crmDealQuery, type CrmContract } from "@/lib/crm.ts";
import { crmErrorToast } from "./crm-errors.ts";

interface Draft {
  key: number;
  name: string;
  email: string;
}

/** The deal's people with an address, or one blank row; `loading` until the deal is read. */
export function useStartingSigners(dealId: string | null) {
  const deal = useQuery({ ...crmDealQuery(dealId ?? ""), enabled: Boolean(dealId) });
  const people = deal.data?.people ?? [];
  const found = people.flatMap((person) => {
    const email = person.addresses[0]?.address;
    return email ? [{ name: person.name, email }] : [];
  });
  const rows = found.length ? found : [{ name: "", email: "" }];
  return {
    loading: Boolean(dealId) && deal.isPending,
    starting: rows.map((row, key) => ({ key, ...row })),
  };
}

export function SendContractDialog(props: { contract: CrmContract; onClose: () => void }) {
  const { loading, starting } = useStartingSigners(props.contract.dealId);
  if (loading) return null;
  return <SendForm {...props} starting={starting} />;
}

function SendForm(props: { contract: CrmContract; starting: Draft[]; onClose: () => void }) {
  const send = useSendContract();
  const [drafts, setDrafts] = useState<Draft[]>(props.starting);
  const [next, setNext] = useState(props.starting.length + 1);
  const signers = drafts
    .map((draft) => ({ name: draft.name.trim(), email: draft.email.trim() }))
    .filter((signer) => signer.name || signer.email);
  const ready = signers.length > 0 && signers.every((signer) => signer.name && signer.email);
  const change = (key: number, patch: Partial<Draft>) =>
    setDrafts((all) => all.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  return (
    <Dialog size="md" isOpen onOpenChange={(isOpen) => !isOpen && props.onClose()}>
      <DialogHeader>
        <DialogTitle className="truncate">Send “{props.contract.title}” for signature</DialogTitle>
      </DialogHeader>
      <form
        className="contents"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          send.mutate(
            { id: props.contract.id, signers },
            {
              onSuccess: props.onClose,
              onError: (error) => crmErrorToast(error, "The contract was not sent"),
            },
          );
        }}
      >
        <DialogBody>
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
    </Dialog>
  );
}
