import type { CSSProperties } from "react";
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
