import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLogoSource, type LogoFor, type LogoSource } from "@/lib/sender-logo.ts";
import { colors, radius, rowLead } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A person or company, round. Their picture once one loads: a photo (a Gravatar, an account's
 * photo, a workspace's logo) fills the avatar edge to edge; a sender's company mark (a favicon)
 * is drawn at 85% on a white tile, as the web insets it. `fill` makes any picture fill, a mark
 * too: an account's own avatar always fills. Their initial on the accent fill until then, and
 * when there is none. A sender is `square` (corners at
 * 20% of its size, as the web's `isSquare`, with a hairline edge). A workspace is `inverse`: its
 * initial in white on the brand's blue.
 */
export function Avatar({
  name,
  logo,
  photo,
  initials,
  size = rowLead,
  inverse = false,
  shape = "round",
  fill = false,
}: {
  name: string;
  /** Whose logo to look up; leave out for the initial only. */
  logo?: LogoFor | null;
  /** A picture of its own (a workspace's logo), filling the avatar; wins over `logo`. */
  photo?: LogoSource | null;
  /** What it shows in place of the name's initial ("+2", or nothing for a blank face). */
  initials?: string;
  size?: number;
  inverse?: boolean;
  shape?: "round" | "square";
  /** Fill the avatar with whatever picture loads, a company's mark too (an account's avatar). */
  fill?: boolean;
}) {
  const looked = useLogoSource(logo ?? null);
  const source = photo ?? looked;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const initial = initials ?? initialOf(name);
  const tried = source && failed !== source.uri ? source : null;
  const showing = tried && loaded === tried.uri ? tried : null;
  const square = shape === "square";
  const corner = square ? Math.round(size * SQUARE_CORNER) : radius.full;
  const mark = isMark(showing, fill);
  const inset = isMark(tried, fill);
  return (
    <View
      accessible={false}
      style={[
        styles.avatar,
        { width: size, height: size, borderRadius: corner },
        inverse && styles.inverse,
        mark && styles.tile,
      ]}
    >
      {showing ? null : (
        <Text size={initialSize(size)} {...initialInk(inverse)} allowFontScaling={false}>
          {initial}
        </Text>
      )}
      {tried ? (
        <Image
          source={{ uri: tried.uri, headers: tried.headers }}
          cachePolicy="disk"
          {...(inset ? INSET : FILLED)}
          transition={150}
          onLoad={() => setLoaded(tried.uri)}
          onError={() => setFailed(tried.uri)}
        />
      ) : null}
      {square || mark ? (
        <View pointerEvents="none" style={[styles.edge, { borderRadius: corner }]} />
      ) : null}
    </View>
  );
}

const SQUARE_CORNER = 0.2;

const FILLED = { contentFit: "cover", style: StyleSheet.absoluteFill } as const;

const isMark = (source: LogoSource | null, fill: boolean) => !!source && !source.photo && !fill;

const initialOf = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

const initialInk = (inverse: boolean) =>
  inverse
    ? ({ weight: "semibold", tone: "primaryForeground" } as const)
    : ({ weight: "medium", tone: "mutedForeground" } as const);

const initialSize = (size: number) => {
  if (size >= 56) return "title";
  if (size >= 44) return "lg";
  return size >= 28 ? "sm" : "xs";
};

/** An avatar you can press (the workspace's, in a page's header). Squeezes while pressed. */
export function AvatarButton({
  label,
  onPress,
  ...avatar
}: Parameters<typeof Avatar>[0] & { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Avatar {...avatar} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pressed: { transform: [{ scale: 0.97 }] },
  avatar: {
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  inverse: { backgroundColor: colors.primary },
  edge: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  tile: { backgroundColor: colors.logoTile },
  inset: { position: "absolute", top: "7.5%", left: "7.5%", width: "85%", height: "85%" },
});

const INSET = { contentFit: "contain", style: styles.inset } as const;
