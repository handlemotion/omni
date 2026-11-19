import { Image } from "expo-image";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLogoSource, type LogoFor, type LogoSource } from "@/lib/sender-logo.ts";
import { colors, radius, rowLead } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A person or company, round. Their logo once one loads (a company's mark inset on a white
 * tile, a Gravatar filling the circle); their initial on the accent fill until then, and when
 * there is none. A sender is `square` (corners at 20% of its size, as the web's `isSquare`, with a
 * hairline edge), its logo at 85% of the tile. A workspace is `inverse`: its initial on the foreground fill.
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
  const inset = Math.round(size * (square ? LOGO_INSET.square : LOGO_INSET.round));
  return (
    <View
      accessible={false}
      style={[
        styles.avatar,
        { width: size, height: size },
        square && [styles.edge, { borderRadius: Math.round(size * SQUARE_CORNER) }],
        inverse && styles.inverse,
        showing && !showing.photo ? styles.tile : null,
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
          contentFit={tried.photo ? "cover" : "contain"}
          transition={150}
          onLoad={() => setLoaded(tried.uri)}
          onError={() => setFailed(tried.uri)}
          style={[StyleSheet.absoluteFill, tried.photo ? null : { margin: inset }]}
        />
      ) : null}
    </View>
  );
}

const SQUARE_CORNER = 0.2;
const LOGO_INSET = { square: 0.075, round: 0.2 };

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
  edge: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  tile: {
    backgroundColor: colors.logoTile,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
});
