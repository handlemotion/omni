import { Image } from "expo-image";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLogoSource, type LogoFor } from "@/lib/sender-logo.ts";
import { colors, radius, rowLead } from "@/theme/tokens.ts";
import { Text } from "./text.tsx";

/**
 * A person or company, round. Their logo once one loads (a company's mark inset on a white
 * tile, a Gravatar filling the circle); their initial on the accent fill until then, and when
 * there is none.
 */
export function Avatar({
  name,
  logo,
  size = rowLead,
}: {
  name: string;
  /** Whose logo to look up; leave out for the initial only. */
  logo?: LogoFor | null;
  size?: number;
}) {
  const source = useLogoSource(logo ?? null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const tried = source && failed !== source.uri ? source : null;
  const showing = tried && loaded === tried.uri ? tried : null;
  const inset = Math.round(size * 0.2);
  return (
    <View
      accessible={false}
      style={[
        styles.avatar,
        { width: size, height: size },
        showing && !showing.photo ? styles.tile : null,
      ]}
    >
      {showing ? null : (
        <Text
          size={size >= 56 ? "title" : size >= 40 ? "lg" : "sm"}
          weight="medium"
          tone="mutedForeground"
          allowFontScaling={false}
        >
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

const styles = StyleSheet.create({
  avatar: {
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  tile: {
    backgroundColor: colors.logoTile,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
});
