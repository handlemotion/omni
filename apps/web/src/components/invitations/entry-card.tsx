import type { ReactNode } from "react";
import { IconOmniMark } from "@/components/icons";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";

/**
 * The sign-in card's frame (Figma: Omni, frame "/"), as `/join` uses it: the mark and a heading
 * at the top, the actions stacked at the foot. `children` sits between them and scrolls when
 * it outgrows the card.
 */
export function EntryCard(props: { title: string; children?: ReactNode; actions: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4">
      <div className="flex h-137.5 w-100 max-w-full flex-col pb-12">
        <Card className="min-h-0 flex-1 justify-between gap-6 p-6">
          <div className="flex min-h-0 flex-col gap-5">
            <IconOmniMark />
            <Heading className="text-balance">{props.title}</Heading>
            {props.children}
          </div>
          <div className="flex shrink-0 flex-col gap-2">{props.actions}</div>
        </Card>
      </div>
    </main>
  );
}

/** "Admin", "Member": an invitation's role as a person reads it. */
export function roleLabel(role: string) {
  const first = role.split(",")[0]?.trim() || "member";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Who sent an invitation: their name, else their address. */
export const inviterName = (inviter: { name: string; email: string }) =>
  inviter.name.trim() || inviter.email;
