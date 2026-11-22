import { IconMail } from "@/components/icons/central";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { appToast } from "@/components/ui/toast";
import { useMeetingDraft, useMeetingWrites } from "@/hooks/use-meetings.ts";
import type { MeetingAction } from "@/lib/meetings.ts";

type Payload = {
  title?: string;
  owner?: string | null;
  due?: string | null;
  to?: string[];
  subject?: string;
  body?: string;
};

/** A suggested task (checked, it is in the calendar) or follow-up email (opened as a draft). */
export function ActionItem({ action, canDecide }: { action: MeetingAction; canDecide: boolean }) {
  const { decideAction } = useMeetingWrites();
  const draft = useMeetingDraft();
  const payload = action.payload as Payload;
  const open = action.state === "open";
  const decide = (accept: boolean) =>
    decideAction.mutate(
      { id: action.id, accept },
      { onError: () => appToast.error("That action could not be saved") },
    );
  if (action.kind === "email") {
    return (
      <li className="group/item -mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-hover">
        <span className="grid w-5 shrink-0 place-items-center">
          <IconMail className="size-icon text-muted-foreground" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-y-0.5 py-1.5">
          <span className="truncate text-sm">{payload.subject}</span>
          <span className="truncate text-xs text-muted-foreground">
            {(payload.to ?? []).join(", ")}
          </span>
        </span>
        {open && canDecide && (
          <span className="flex shrink-0 items-center gap-1">
            <Button
              intent="plain"
              size="sm"
              onPress={() => decide(false)}
              className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            >
              Dismiss
            </Button>
            <Button
              intent="outline"
              size="sm"
              isPending={draft.isPending}
              onPress={() =>
                draft.mutate(
                  {
                    actionId: action.id,
                    email: {
                      to: payload.to ?? [],
                      subject: payload.subject ?? "",
                      body: payload.body ?? "",
                    },
                  },
                  { onError: () => appToast.error("The draft could not be made") },
                )
              }
            >
              Open draft
            </Button>
          </span>
        )}
        {!open && (
          <Badge intent="secondary">{action.state === "done" ? "Drafted" : "Dismissed"}</Badge>
        )}
      </li>
    );
  }
  const meta = [payload.owner, payload.due].filter(Boolean).join(" · ");
  return (
    <li className="group/item -mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 hover:bg-hover">
      <span className="grid w-5 shrink-0 place-items-center">
        <CheckboxField
          aria-label={`Add ${payload.title ?? "this task"} to your calendar`}
          isSelected={action.state === "done"}
          isDisabled={!open || !canDecide || decideAction.isPending}
          onChange={(checked: boolean) => {
            if (checked) decide(true);
          }}
        >
          <Checkbox />
        </CheckboxField>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-y-0.5 py-1.5">
        <span
          className={`truncate text-sm ${action.state === "dismissed" ? "text-muted-foreground line-through" : ""}`}
        >
          {payload.title}
        </span>
        {meta && <span className="truncate text-xs text-muted-foreground">{meta}</span>}
      </span>
      {action.state === "done" && <Badge intent="success">In calendar</Badge>}
      {open && canDecide && (
        <Button
          intent="plain"
          size="sm"
          onPress={() => decide(false)}
          className="opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          Dismiss
        </Button>
      )}
    </li>
  );
}
