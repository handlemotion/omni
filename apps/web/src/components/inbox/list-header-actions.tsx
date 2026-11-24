import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { IconArrowRotateClockwise } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger } from "@/components/ui/tooltip";
import { keys } from "@/lib/query-keys.ts";
import { ariaKeyShortcuts } from "@/lib/shortcuts.ts";

/** An icon action in the list's header, the reader's toolbar size, with its tooltip. */
export function HeaderAction(props: {
  label: string;
  shortcut?: Parameters<typeof ariaKeyShortcuts>[0];
  isDisabled?: boolean;
  isPending?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <TooltipTrigger delay={400}>
      <Button
        intent="ghost"
        size="sq-sm"
        aria-label={props.label}
        aria-keyshortcuts={props.shortcut && ariaKeyShortcuts(props.shortcut)}
        isDisabled={props.isDisabled}
        isPending={props.isPending}
        onPress={props.onPress}
      >
        {props.children}
      </Button>
      <Tooltip>{props.label}</Tooltip>
    </TooltipTrigger>
  );
}

/** Fetches everything on screen again: the lists, the open thread, the counts. */
export function ReloadAction() {
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  return (
    <HeaderAction
      label="Reload"
      isPending={pending}
      onPress={() => {
        setPending(true);
        void client
          .refetchQueries({
            type: "active",
            predicate: (query) => query.queryKey[1] !== keys.local()[1],
          })
          .finally(() => setPending(false));
      }}
    >
      <IconArrowRotateClockwise />
    </HeaderAction>
  );
}
