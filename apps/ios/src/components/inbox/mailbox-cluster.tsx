import { StyleSheet, View } from "react-native";
import { Avatar } from "@/components/ui/avatar.tsx";
import { colors, radius } from "@/theme/tokens.ts";
import { MailboxAvatar, type MailboxFace } from "./mailbox-avatar.tsx";

/** One face in a cluster: a mailbox and what it's called; no mailbox draws a blank one. */
export interface ClusterFace {
  key: string;
  name: string;
  mailbox: MailboxFace | null;
}

const RING = 1.5;

function spots(count: number, size: number) {
  if (count <= 1) return [{ x: 0, y: 0, d: size }];
  if (count === 2) {
    const d = size * 0.62;
    return [
      { x: 0, y: 0, d },
      { x: size - d, y: size - d, d },
    ];
  }
  const d = size / 1.88;
  const side = d * 0.88;
  const top = (size - (side * Math.sqrt(3)) / 2 - d) / 2;
  return [
    { x: 0, y: top, d },
    { x: side, y: top, d },
    { x: side / 2, y: top + (side * Math.sqrt(3)) / 2, d },
  ];
}

/**
 * Every mailbox at once, as the web's chooser draws All mailboxes: two faces overlapping, a
 * third as "+N" when there are more, each ringed in the background.
 */
export function MailboxCluster({ faces, size }: { faces: ClusterFace[]; size: number }) {
  const shown: (ClusterFace | { more: number })[] =
    faces.length > 2 ? [...faces.slice(0, 2), { more: faces.length - 2 }] : faces;
  const at = spots(shown.length, size);
  return (
    <View accessible={false} style={{ width: size, height: size }}>
      {shown.map((item, i) => {
        const spot = at[i] ?? { x: 0, y: 0, d: size };
        return (
          <View
            key={"more" in item ? "more" : item.key}
            style={[styles.ring, { left: spot.x - RING, top: spot.y - RING }]}
          >
            {"more" in item ? (
              <Avatar name="More" initials={`+${item.more}`} size={spot.d} />
            ) : item.mailbox ? (
              <MailboxAvatar mailbox={item.mailbox} name={item.name} size={spot.d} />
            ) : (
              <Avatar name="" initials="" size={spot.d} />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: {
    position: "absolute",
    padding: RING,
    borderRadius: radius.full,
    backgroundColor: colors.background,
  },
});
