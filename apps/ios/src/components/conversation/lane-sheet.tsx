import type { ComponentType } from "react";
import type { SvgProps } from "react-native-svg";
import { IconBubble, IconBubbleDots, IconCheck, IconReply } from "@/components/icons.ts";
import { MenuRow } from "@/components/shell/menu-row.tsx";
import { BottomSheet } from "@/components/ui/bottom-sheet.tsx";
import { useLaneChange, type Lane } from "@/lib/conversation.ts";
import { colors, iconSize } from "@/theme/tokens.ts";

type Glyph = ComponentType<SvgProps & { size?: number }>;

/** Each lane's label (the web's) and glyph, in the order the sheet lists them. */
export const LANES: Record<Lane, { label: string; icon: Glyph }> = {
  needs_reply: { label: "Needs reply", icon: IconReply },
  waiting_on_them: { label: "Awaiting reply", icon: IconBubbleDots },
  fyi: { label: "FYI", icon: IconBubble },
  noise: { label: "Noise", icon: IconBubble },
};
const ORDER = Object.keys(LANES) as Lane[];

/** The lane button's sheet: every lane, the thread's own checked; a tap files it there. */
export function LaneSheet(props: {
  isOpen: boolean;
  onClose: () => void;
  threadId: string;
  lane: Lane | null;
}) {
  const change = useLaneChange(props.threadId);
  return (
    <BottomSheet isOpen={props.isOpen} onClose={props.onClose} title="Lane">
      {ORDER.map((lane) => (
        <MenuRow
          key={lane}
          icon={LANES[lane].icon}
          muted
          label={LANES[lane].label}
          trailing={
            lane === props.lane ? (
              <IconCheck size={iconSize.md} color={colors.foreground} />
            ) : undefined
          }
          onPress={() => {
            props.onClose();
            change(lane);
          }}
        />
      ))}
    </BottomSheet>
  );
}
