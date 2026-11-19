import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLogoSource, type LogoFor, type LogoSource } from "@/lib/sender-logo.ts";
import { colors, radius, rowLead } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A person or company, round. Their picture once one loads, always filling the avatar edge to
 * edge (a company's mark, a Gravatar, an account's photo, a workspace's logo), never inset: a
 * mark's own background is the avatar's colour, and a transparent one sits on a white tile. Their
 * initial on the accent fill until then, and when there is none. A sender is `square` (corners at
 * 20% of its size, as the web's `isSquare`, with a hairline edge). A workspace is `inverse`: its
 * initial on the foreground fill.
 */
export function Avatar({
  name,
  logo,
  photo,
  initials,
  size = rowLead,
  inverse = false,
  shape = "round",
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
  const mark = !!showing && !showing.photo;
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
          contentFit="cover"
          transition={150}
          onLoad={() => setLoaded(tried.uri)}
          onError={() => setFailed(tried.uri)}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      {square || mark ? (
        <View pointerEvents="none" style={[styles.edge, { borderRadius: corner }]} />
      ) : null}
    </View>
  );
}

const SQUARE_CORNER = 0.2;

const initialOf = (name: string) => name.trim().charAt(0).toUpperCase() || "?";

const initialInk = (inverse: boolean) =>
  inverse
    ? ({ weight: "semibold", tone: "background" } as const)
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
  inverse: { backgroundColor: colors.foreground },
  edge: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  tile: { backgroundColor: colors.logoTile },
});
