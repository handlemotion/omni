import { useRef } from "react";
import { IconImage, IconTrash } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { FileTrigger } from "@/components/ui/file-trigger";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useCrmCompanyIndex, useRemoveDealIcon, useSetDealIcon } from "@/hooks/use-crm.ts";
import type { CrmDeal } from "@/lib/crm.ts";
import { crmErrorToast } from "./crm-errors.ts";
import { RecordMark } from "./record-list.tsx";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/**
 * A deal's mark in its header: its uploaded picture, else its client's logo. Pressing it offers to
 * upload a picture, or to remove the one it has.
 */
export function DealMark(props: {
  deal: CrmDeal;
  client: { name: string; domain: string | null } | null;
  size: number;
}) {
  const { deal, client } = props;
  const input = useRef<HTMLInputElement>(null);
  const upload = useSetDealIcon();
  const remove = useRemoveDealIcon();
  const mark = (
    <RecordMark
      name={client?.name ?? deal.name}
      square
      size={props.size}
      src={deal.iconUrl}
      who={client?.domain ? { domain: client.domain } : null}
    />
  );
  return (
    <>
      <FileTrigger
        ref={input}
        acceptedFileTypes={IMAGE_TYPES}
        onSelect={(files) => {
          const file = files?.[0];
          if (!file) return;
          upload.mutate(
            { id: deal.id, file },
            { onError: (error) => crmErrorToast(error, "The picture was not saved") },
          );
        }}
      />
      <MenuTrigger>
        <Button
          intent="plain"
          aria-label="Project icon"
          isPending={upload.isPending}
          className="size-auto shrink-0 rounded-[20%] p-0"
        >
          {mark}
        </Button>
        <Menu placement="bottom start" aria-label="Project icon">
          <MenuItem id="upload" textValue="Upload image" onAction={() => input.current?.click()}>
            <IconImage data-slot="icon" />
            <MenuLabel>Upload image</MenuLabel>
          </MenuItem>
          {deal.iconUrl ? (
            <MenuItem
              id="remove"
              textValue="Remove image"
              intent="danger"
              onAction={() =>
                remove.mutate(deal.id, {
                  onError: (error) => crmErrorToast(error, "The picture was not removed"),
                })
              }
            >
              <IconTrash data-slot="icon" />
              <MenuLabel>Remove image</MenuLabel>
            </MenuItem>
          ) : null}
        </Menu>
      </MenuTrigger>
    </>
  );
}

/** A deal's mark in lists: its uploaded picture, else its client's logo, else its initial. */
export function DealIcon(props: { deal: CrmDeal; size?: number }) {
  const client = useCrmCompanyIndex().get(props.deal.companyId ?? "");
  return (
    <RecordMark
      name={client?.name ?? props.deal.name}
      square={!!(client || props.deal.iconUrl)}
      size={props.size}
      src={props.deal.iconUrl}
      who={client?.domain ? { domain: client.domain } : null}
    />
  );
}
