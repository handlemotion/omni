import { useMutation } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { AppleMark } from "@/components/brand/apple-mark.tsx";
import { GoogleMark } from "@/components/brand/google-mark.tsx";
import { OmniGlobe } from "@/components/brand/omni-mark.tsx";
import { IconMail } from "@/components/icons.ts";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Text } from "@/components/ui/text.tsx";
import { signInInBrowser, useSession } from "@/lib/session.ts";
import { useSplashDone } from "@/lib/splash.ts";
import { gutter, space } from "@/theme/tokens.ts";

/** The welcome screen: centered Omni globe and stacked white pill sign-in buttons. */
export default function SignIn() {
  const session = useSession();
  const { error } = useLocalSearchParams<{ error?: string }>();
  const signIn = useMutation({ mutationFn: signInInBrowser });
  useSplashDone(!session.data);

  if (session.data) return <Redirect href="/mail" />;

  const failed = signIn.isError || signIn.data === "error" || (!!error && signIn.isIdle);
  const start = () => signIn.mutate();

  return (
    <Screen>
      <View style={styles.body}>
        <View style={styles.hero}>
          <OmniGlobe size={40} />
          <Text size="title" weight="medium" accessibilityRole="header" style={styles.center}>
            Sign in to Omni
          </Text>
        </View>
        <View style={styles.footer}>
          <View style={styles.actions}>
            <Button
              intent="outline"
              size="lg"
              icon={GoogleMark}
              label={failed ? "Try again" : "Continue with Google"}
              isPending={signIn.isPending}
              onPress={start}
            />
            <Button
              intent="outline"
              size="lg"
              icon={AppleMark}
              label="Sign in with Apple"
              disabled={signIn.isPending}
              onPress={() => undefined}
            />
            <Button
              intent="outline"
              size="lg"
              icon={IconMail}
              label="Continue with email"
              disabled={signIn.isPending}
              onPress={start}
            />
          </View>
          <Text size="xs" tone="subtleForeground" style={[styles.center, styles.legal]}>
            By continuing, you agree to our Terms of Service and Privacy Policy.
          </Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: gutter + space(1), paddingBottom: space(4) },
  hero: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space(5.5),
    paddingBottom: space(6),
  },
  center: { textAlign: "center" },
  footer: { gap: space(4.5) },
  actions: { gap: space(2.5) },
  legal: { paddingHorizontal: space(4) },
});
