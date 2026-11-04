// Which workspace the settings below it act on. A row in the settings nav, laid out like its
// page rows (32px, 8px in, a 15px mark 10px before the name), that opens a menu of every
// workspace you belong to, a check on the active one. Choosing another switches to it: settings
// act on the active workspace (ADR 0014). An owner or admin of a workspace still being set up
// goes to onboarding instead, as from the mailbox switcher (ADR 0009).
import { IconCheck, IconChevronsUpDown } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { Menu, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu";
import { appToast } from "@/components/ui/toast";
import { useMember, useSetActiveOrganization } from "@/hooks/use-session.ts";
import { closeSettings } from "@/hooks/use-settings-dialog.ts";
import { useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import { needsSetup } from "@/lib/onboarding.ts";
import { WorkspaceAvatar } from "./workspace-pages";

export function WorkspaceChooser() {
  const { member } = useMember();
  const workspaces = useWorkspaces().data?.workspaces ?? [];
  const switchTo = useSetActiveOrganization();
  const openWorkspace = useOpenWorkspace();
  const active = workspaces.find((w) => w.id === member.orgId);
  if (!active) return null;

  const choose = (id: string) => {
    const target = workspaces.find((w) => w.id === id);
    if (!target || target.id === member.orgId) return;
    if (needsSetup(target)) {
      closeSettings();
      openWorkspace.mutate(target);
      return;
    }
    switchTo.mutate(target.id, {
      onError: () => appToast.error("The workspace could not be opened."),
    });
  };

  return (
    <MenuTrigger>
      <Button
        intent="plain"
        aria-label={`Workspace: ${active.name}. Choose another`}
        // Hover, pressed and open share the accent fill, as on the mailbox switcher; the mark and
        // name sit on the page rows' icon and label axes. As a menu trigger it skips the press
        // scale (`Button` leaves out `aria-haspopup`).
        className="h-8 w-full justify-start gap-2.5 rounded-lg px-2 [--btn-overlay:var(--color-accent)] aria-expanded:[--btn-bg:var(--color-accent)]"
      >
        <span className="grid size-icon shrink-0 place-items-center">
          {switchTo.isPending ? (
            <Loader className="size-icon text-muted-foreground" />
          ) : (
            <WorkspaceAvatar workspace={active} size={15} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-start">{active.name}</span>
        <IconChevronsUpDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </Button>
      {/* As wide as its trigger, so the menu reads as the chooser opened. */}
      <Menu
        placement="bottom start"
        popover={{ className: "w-(--trigger-width) min-w-(--trigger-width) max-w-none" }}
        onAction={(key) => choose(String(key))}
      >
        {workspaces.map((w) => (
          <MenuItem key={w.id} id={w.id} textValue={w.name} className="pe-2.5">
            <WorkspaceAvatar workspace={w} size={15} />
            {/* The check rides inside the label, so it sits on the name's line; after the label
                the menu row would lift it out of line (an absolute icon slot). It mirrors the
                mark: 14px, 10px in from the row's end as the mark is from its start. */}
            <MenuLabel className="flex min-w-0 items-center justify-between gap-3">
              <span className="truncate">{w.name}</span>
              {w.id === member.orgId && <IconCheck className="size-3.5 shrink-0 text-foreground" />}
            </MenuLabel>
          </MenuItem>
        ))}
      </Menu>
    </MenuTrigger>
  );
}
