import { useNavigate } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { VisuallyHidden } from "react-aria-components/VisuallyHidden";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Dialog, DialogBody, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAnnouncement, useShortcut, useShortcutListener } from "@/hooks/use-shortcuts.ts";
import { keyLabel, SHORTCUT_IDS, SHORTCUTS, type KeySequence } from "@/lib/shortcuts.ts";

/**
 * The app-wide keys: compose, go-to and `?`. List keys live on the thread list; `/` and ⌘K
 * belong to the title-bar search popover. Mounted once by the member shell.
 */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const [help, setHelp] = useState(false);
  useShortcutListener();
  useShortcut("compose", () => void navigate({ to: "/compose" }));
  useShortcut("goInbox", () => void navigate({ to: "/inbox" }));
  useShortcut("goQueue", () => void navigate({ to: "/queue" }));
  useShortcut("goAll", () => void navigate({ to: "/all" }));
  useShortcut("help", () => setHelp(true));

  return (
    <>
      <ShortcutList isOpen={help} onOpenChange={setHelp} />
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

function Announcer() {
  const message = useAnnouncement();
  return (
    <VisuallyHidden role="status" aria-live="polite">
      {message}
    </VisuallyHidden>
  );
}
