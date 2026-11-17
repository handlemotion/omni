import { Button } from "@/components/ui/button";
import { appToast } from "@/components/ui/toast";
import { useUnsubscribe } from "@/hooks/use-mail-actions.ts";
import type { Message } from "@/lib/types.ts";

/**
 * Unsubscribe, as text on the sender's line of list mail. One-click and mailto lists are done by
 * the API; a list that only offers a page opens it in a new tab. Done, it reads Unsubscribed, grey.
 */
export function Unsubscribe({ threadId, message }: { threadId: string; message: Message }) {
  const leave = useUnsubscribe();
  const option = message.unsubscribe;
  if (!option) return null;
  const done = leave.isSuccess;
  const press = () => {
    if (option.url) window.open(option.url, "_blank", "noopener,noreferrer");
    else
      leave.mutate(
        { threadId, messageId: message.id },
        { onError: () => appToast.error("Unsubscribe failed") },
      );
  };
  return (
    <Button
      intent="plain"
      size="text"
      isPending={leave.isPending}
      isDisabled={done}
      onPress={press}
      className={
        done
          ? "shrink-0 [--btn-foreground:var(--color-muted-foreground)] disabled:opacity-100"
          : "shrink-0 [--btn-foreground:var(--color-danger)]"
      }
    >
      {done ? "Unsubscribed" : "Unsubscribe"}
    </Button>
  );
}
