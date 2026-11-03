import { useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { VisuallyHidden } from "react-aria-components/VisuallyHidden";
import {
  CommandMenu,
  CommandMenuItem,
  CommandMenuLabel,
  CommandMenuList,
  CommandMenuSearch,
  CommandMenuSection,
  CommandMenuShortcut,
} from "@/components/ui/command-menu";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useMember, useOrganizations, useSetActiveOrganization } from "@/hooks/use-session.ts";
import {
  runShortcut,
  useAnnouncement,
  useAvailableShortcuts,
  useShortcut,
  useShortcutListener,
} from "@/hooks/use-shortcuts.ts";
import {
  keyLabel,
  SHORTCUT_IDS,
  SHORTCUTS,
  type KeySequence,
  type ShortcutId,
} from "@/lib/shortcuts.ts";

/**
 * The app-wide keys: compose, go-to, `?` and ⌘K. List keys live on the thread list. Mounted
 * once by the member shell.
 */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const [help, setHelp] = useState(false);
  const [menu, setMenu] = useState(false);
  useShortcutListener();
  useShortcut("compose", () => void navigate({ to: "/compose" }));
  useShortcut("goInbox", () => void navigate({ to: "/inbox" }));
  useShortcut("goQueue", () => void navigate({ to: "/queue" }));
  useShortcut("goAll", () => void navigate({ to: "/all" }));
  useShortcut("help", () => setHelp(true));
  useShortcut("commandMenu", () => setMenu(true));

  return (
    <>
      <ShortcutList isOpen={help} onOpenChange={setHelp} />
      <Commands isOpen={menu} onOpenChange={setMenu} />
      <Announcer />
    </>
  );
}

// Layout not in Figma yet: the Dialog and DescriptionList primitives as they are, one row per
// shortcut in definition order.
function ShortcutList(props: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog isOpen={props.isOpen} onOpenChange={props.onOpenChange} size="md">
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
      </DialogHeader>
      <DialogBody>
        <DescriptionList>
          {SHORTCUT_IDS.map((id) => (
            <Fragment key={id}>
              <DescriptionTerm>{SHORTCUTS[id].label}</DescriptionTerm>
              <DescriptionDetails>
                {SHORTCUTS[id].keys.map((sequence, i) => (
                  <Fragment key={sequence.join(" ")}>
                    {i > 0 && " or "}
                    <Keys sequence={sequence} />
                  </Fragment>
                ))}
              </DescriptionDetails>
            </Fragment>
          ))}
        </DescriptionList>
      </DialogBody>
    </Dialog>
  );
}

function Keys({ sequence }: { sequence: KeySequence }) {
  return sequence.map((key, i) => (
    <Fragment key={key}>
      {i > 0 && " then "}
      <kbd>{keyLabel(key).join(" ")}</kbd>
    </Fragment>
  ));
}

const GROUPS = ["Go to", "Threads", "General"] as const;

/**
 * ⌘K: every command the screen handles right now, plus switching workspace. A command runs the
 * same handler as its key, so the two can't disagree.
 */
function Commands(props: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const available = useAvailableShortcuts();
  const { member } = useMember();
  const organizations = useOrganizations();
  const setActive = useSetActiveOrganization();
  const others = (organizations.data ?? []).filter((org) => org.id !== member.orgId);
  const run = (id: ShortcutId) => {
    props.onOpenChange(false);
    runShortcut(id);
  };

  return (
    <CommandMenu isOpen={props.isOpen} onOpenChange={props.onOpenChange} aria-label="Commands">
      <CommandMenuSearch placeholder="Type a command" />
      <CommandMenuList>
        {GROUPS.map((group) => {
          const ids = SHORTCUT_IDS.filter(
            (id) =>
              SHORTCUTS[id].group === group && "command" in SHORTCUTS[id] && available.has(id),
          );
          if (!ids.length) return null;
          return (
            <CommandMenuSection key={group} label={group}>
              {ids.map((id) => (
                <CommandMenuItem key={id} textValue={SHORTCUTS[id].label} onAction={() => run(id)}>
                  <CommandMenuLabel>{SHORTCUTS[id].label}</CommandMenuLabel>
                  <CommandMenuShortcut>
                    {(SHORTCUTS[id].keys[0] ?? []).flatMap((key) =>
                      keyLabel(key).map((label) => <span key={label}>{label}</span>),
                    )}
                  </CommandMenuShortcut>
                </CommandMenuItem>
              ))}
            </CommandMenuSection>
          );
        })}
        {others.length > 0 && (
          <CommandMenuSection label="Switch workspace">
            {others.map((org) => (
              <CommandMenuItem
                key={org.id}
                textValue={org.name}
                onAction={() => {
                  props.onOpenChange(false);
                  setActive.mutate(org.id);
                }}
              >
                <CommandMenuLabel>{org.name}</CommandMenuLabel>
              </CommandMenuItem>
            ))}
          </CommandMenuSection>
        )}
      </CommandMenuList>
    </CommandMenu>
  );
}

function Announcer() {
  const message = useAnnouncement();
  return (
    <VisuallyHidden role="status" aria-live="polite">
      {message}
    </VisuallyHidden>
  );
}
