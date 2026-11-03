// The workspace and account switcher in the sidebar header, modelled on transitive's
// organization menu (`apps/transitive/src/components/workspace/workspace-organization-menu.tsx`):
// a compact trigger (avatar, name, chevron) and a 320px panel in sections. Workspaces to switch
// to, the active workspace's mailboxes, settings, then the accounts signed in on this browser
// and log out.
import { CheckIcon } from "@heroicons/react/20/solid";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import {
  IconChevronDown,
  IconCircleDashed,
  IconEmail,
  IconSettings,
} from "@/components/icons/sidebar";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import {
  Menu,
  MenuItem,
  MenuSection,
  MenuSeparator,
  MenuSubMenu,
  MenuTrigger,
} from "@/components/ui/menu";
import { appToast } from "@/components/ui/toast";
import {
  useDeviceSessions,
  useMember,
  useSession,
  useSignOut,
  useSwitchAccount,
} from "@/hooks/use-session.ts";
import { useOpenMailbox, useOpenWorkspace, useWorkspaces } from "@/hooks/use-workspaces.ts";
import type { Workspace } from "@/lib/types.ts";

/** A row's content: one flex line inside the menu item's grid. */
const ROW = "col-span-full flex min-w-0 items-center gap-2.5";

/** A square avatar slot that turns into a spinner while that row's switch is under way. */
function RowAvatar(props: {
  name: string;
  src?: string | null;
  isSquare?: boolean;
  loading?: boolean;
}) {
  return (
    <span className="grid size-4.5 shrink-0 place-items-center">
      {props.loading ? (
        <Loader className="size-3.5 text-muted-foreground" />
      ) : (
        <Avatar
          isSquare={props.isSquare}
          src={props.src ?? null}
          initials={props.name.slice(0, 1).toUpperCase()}
          className="bg-accent text-foreground outline-0 [--avatar-radius:var(--radius-sm)] [--avatar-size:--spacing(4.5)]"
        />
      )}
    </span>
  );
}

/** The check on the chosen row; an empty slot keeps names aligned. */
function Chosen({ chosen }: { chosen: boolean }) {
  return (
    <span aria-hidden className="ms-auto grid size-4 shrink-0 place-items-center">
      {chosen && <CheckIcon className="size-4 text-foreground" />}
    </span>
  );
}

export function WorkspaceSwitcher() {
  const { member } = useMember();
  const session = useSession();
  // Loaded with the sidebar, so the panel opens filled.
  const workspaces = useWorkspaces();
  const accounts = useDeviceSessions();
  const openWorkspace = useOpenWorkspace();
  const openMailbox = useOpenMailbox();
  const switchAccount = useSwitchAccount();
  const signOut = useSignOut();
  const { mailbox } = useSearch({ strict: false }) as { mailbox?: string };
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);

  const all = workspaces.data?.workspaces ?? [];
  const active = all.find((workspace) => workspace.id === member.orgId);
  const activeToken = session.data?.session.token;
  const otherAccounts = (accounts.data ?? []).length > 1 ? (accounts.data ?? []) : [];

  const switchWorkspace = (workspace: Workspace) => {
    if (workspace.id === member.orgId || switchingTo) return;
    setSwitchingTo(workspace.id);
    openWorkspace.mutate(workspace, {
      onError: () => appToast.error("The workspace could not be switched. Try again."),
      onSettled: () => setSwitchingTo(null),
    });
  };

  const switchToAccount = (token: string) => {
    if (token === activeToken || switchingTo) return;
    setSwitchingTo(token);
    switchAccount.mutate(token, {
      onError: () => appToast.error("The account could not be switched. Try again."),
      onSettled: () => setSwitchingTo(null),
    });
  };

  const name = active?.name ?? "";

  return (
    <MenuTrigger>
      <Button
        intent="plain"
        aria-label={`Switch workspace, currently ${name}`}
        className="h-7 min-w-0 flex-1 justify-start gap-1.5 rounded-sm px-2 hover:bg-hover aria-expanded:bg-hover"
      >
        <RowAvatar isSquare name={name} src={active?.logo} />
        <span className="min-w-0 truncate">{name}</span>
        <IconChevronDown className="size-3.5 shrink-0 text-subtle-foreground" />
      </Button>

      <Menu
        placement="bottom start"
        popover={{ offset: 8, className: "w-80 max-w-[calc(100vw-16px)]" }}
        className="p-1.5"
      >
        <MenuSection label="Workspaces">
          {all.map((workspace) => (
            <MenuItem
              key={workspace.id}
              textValue={workspace.name}
              aria-busy={switchingTo === workspace.id || undefined}
              // Stays open while it switches, so the spinner shows where the click was.
              shouldCloseOnSelect={false}
              onAction={() => switchWorkspace(workspace)}
            >
              <span className={ROW}>
                <RowAvatar
                  isSquare
                  name={workspace.name}
                  src={workspace.logo}
                  loading={switchingTo === workspace.id}
                />
                <span
                  className={`min-w-0 flex-1 truncate ${switchingTo === workspace.id ? "opacity-60" : ""}`}
                >
                  {workspace.name}
                </span>
                <Chosen chosen={workspace.id === member.orgId} />
              </span>
            </MenuItem>
          ))}
        </MenuSection>

        <MenuSeparator />

        {/* The active workspace's mailboxes, a scope inside it (transitive's companies). */}
        {active && active.mailboxes.length > 1 && (
          <MenuSubMenu>
            <MenuItem textValue="Mailboxes">
              <span className={ROW}>
                <IconEmail className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">Mailboxes</span>
              </span>
            </MenuItem>
            <Menu popover={{ className: "w-75 max-w-[calc(100vw-16px)]" }} className="p-1.5">
              <MenuItem
                textValue="All mailboxes"
                onAction={() =>
                  openWorkspace.mutate(active, {
                    onError: () => appToast.error("The inbox could not be opened. Try again."),
                  })
                }
              >
                <span className={ROW}>
                  <span className="min-w-0 flex-1 truncate">All mailboxes</span>
                  <Chosen chosen={!mailbox} />
                </span>
              </MenuItem>
              {active.mailboxes.map((box) => (
                <MenuItem
                  key={box.id}
                  textValue={box.address}
                  onAction={() =>
                    openMailbox.mutate(
                      { workspaceId: active.id, mailboxId: box.id },
                      {
                        onError: () =>
                          appToast.error("The mailbox could not be opened. Try again."),
                      },
                    )
                  }
                >
                  <span className={ROW}>
                    <span className="min-w-0 flex-1 truncate">{box.address}</span>
                    <Chosen chosen={mailbox === box.id} />
                  </span>
                </MenuItem>
              ))}
            </Menu>
          </MenuSubMenu>
        )}
        <MenuItem href="/settings" textValue="Settings">
          <span className={ROW}>
            <IconSettings className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">Settings</span>
          </span>
        </MenuItem>

        <MenuSeparator />

        {otherAccounts.length > 0 && (
          <MenuSection label="Accounts">
            {otherAccounts.map(({ session: account, user }) => (
              <MenuItem
                key={account.token}
                textValue={user.email}
                aria-busy={switchingTo === account.token || undefined}
                shouldCloseOnSelect={false}
                onAction={() => switchToAccount(account.token)}
              >
                <span className={ROW} title={user.email}>
                  <RowAvatar
                    name={user.name || user.email}
                    src={user.image}
                    loading={switchingTo === account.token}
                  />
                  <span className="min-w-0 flex-1 truncate">{user.name || user.email}</span>
                  <Chosen chosen={account.token === activeToken} />
                </span>
              </MenuItem>
            ))}
          </MenuSection>
        )}
        <MenuItem
          textValue="Log out"
          aria-busy={signOut.isPending || undefined}
          isDisabled={signOut.isPending}
          shouldCloseOnSelect={false}
          onAction={() => signOut.mutate()}
        >
          <span className={ROW}>
            {signOut.isPending ? (
              <Loader className="size-4 shrink-0 text-muted-foreground" />
            ) : (
              <IconCircleDashed className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">Log out</span>
          </span>
        </MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
