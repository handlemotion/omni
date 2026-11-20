import type { CSSProperties } from "react";
import { IconUserRound, IconUsers } from "@/components/icons/central";
import { Avatar } from "@/components/ui/avatar";

/**
 * A teammate's picture, or their initial on a muted disc; it darkens with a hovered row. Without
 * `size` it takes the size its slot gives it (a menu or select item's avatar).
 */
export function MemberAvatar(props: { name: string; image?: string | null; size?: number }) {
  return (
    <Avatar
      src={props.image ?? null}
      initials={props.name.slice(0, 1).toUpperCase()}
      alt=""
      className="bg-secondary text-muted-foreground outline-0 mix-blend-multiply"
      style={props.size ? ({ "--avatar-size": `${props.size}px` } as CSSProperties) : undefined}
    />
  );
}

/** Nobody (no owner, unassigned): a dashed disc the size of a teammate's picture. */
export function NoMemberAvatar(props: { size?: number }) {
  return (
    <span
      data-slot="avatar"
      aria-hidden
      className="inline-flex size-(--avatar-size) shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/60 text-muted-foreground"
      style={props.size ? ({ "--avatar-size": `${props.size}px` } as CSSProperties) : undefined}
    >
      <IconUserRound className="m-0! size-[62%]!" />
    </span>
  );
}

/** Everyone (all owners, all assignees): two people in an outlined disc, like No owner. */
export function EveryoneAvatar(props: { size?: number }) {
  return (
    <span
      data-slot="avatar"
      aria-hidden
      className="inline-flex size-(--avatar-size) shrink-0 items-center justify-center rounded-full border border-muted-foreground/60 text-muted-foreground"
      style={props.size ? ({ "--avatar-size": `${props.size}px` } as CSSProperties) : undefined}
    >
      <IconUsers className="m-0! size-[62%]!" />
    </span>
  );
}
