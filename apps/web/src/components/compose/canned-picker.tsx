import { IconList } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { useCannedReplies, type CannedReply } from "@/hooks/use-compose.ts";

/**
 * The canned replies of this inbox and your own, from the composer's toolbar. Picking one hands
 * it to `onPick`, which fills its variables in for the conversation. Hidden when there are none.
 */
export function CannedPicker(props: {
  mailboxId: string;
  onPick: (reply: CannedReply) => void;
  isDisabled?: boolean;
}) {
  const replies = useCannedReplies(props.mailboxId).data ?? [];
  if (!replies.length) return null;
  return (
    <MenuTrigger>
      <TooltipTrigger delay={400}>
        <Button
          intent="ghost"
          size="sq-sm"
          aria-label="Canned replies"
          isDisabled={props.isDisabled}
        >
          <IconList />
        </Button>
        <Tooltip>Canned replies</Tooltip>
      </TooltipTrigger>
      <Menu
        placement="top start"
        items={replies}
        popover={{ className: "max-h-80 max-w-[min(20rem,calc(100vw-16px))]" }}
        onAction={(id) => {
          const reply = replies.find((r) => r.id === id);
          if (reply) props.onPick(reply);
        }}
      >
        {(reply) => (
          <MenuItem id={reply.id} textValue={reply.title}>
            <IconList />
            <MenuLabel className="truncate">{reply.title}</MenuLabel>
          </MenuItem>
        )}
      </Menu>
    </MenuTrigger>
  );
}
