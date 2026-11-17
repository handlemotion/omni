import { ChevronUpDownIcon } from "@heroicons/react/20/solid";
import { useNavigate } from "@tanstack/react-router";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuDescription, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { useOpenList } from "../inbox/open-list.tsx";

/**
 * Full screen hides the list; this switches threads from the toolbar instead. Text only, like the
 * sidebar's mailbox switcher: the open thread's sender, then a menu of the list's threads, each
 * leading with its sender's square, as in the list.
 */
export function ThreadSwitcher({ threadId }: { threadId: string }) {
  const list = useOpenList();
  const navigate = useNavigate();
  if (!list?.rows.length) return null;
  const current = list.rows.find((row) => row.id === threadId);
  const label = current ? current.sender : "Switch email";
  return (
    <MenuTrigger>
      <Button
        intent="plain"
        aria-label={`Switch email, currently ${label}`}
        className="h-7 min-w-0 justify-start gap-1.5 rounded-sm px-2 [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)]"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronUpDownIcon className="size-3.5 shrink-0 text-subtle-foreground" />
      </Button>
      <Menu
        placement="bottom start"
        selectionMode="single"
        selectedKeys={[threadId]}
        popover={{ className: "max-h-96 max-w-[min(24rem,calc(100vw-16px))]" }}
        onSelectionChange={(keys) => {
          const next = [...keys][0];
          if (next && next !== threadId) void navigate({ href: list.href(String(next)) });
        }}
      >
        {list.rows.map((row) => (
          <MenuItem key={row.id} id={row.id} textValue={`${row.sender} ${row.subject}`}>
            <Avatar
              data-slot="avatar"
              isSquare
              initials={row.sender.slice(0, 1).toUpperCase()}
              className="bg-accent text-foreground outline-0 [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(4.5)]"
            />
            <MenuLabel>{row.sender}</MenuLabel>
            <MenuDescription>{row.subject || "(no subject)"}</MenuDescription>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}
