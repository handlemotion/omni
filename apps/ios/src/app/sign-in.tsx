import { useMutation } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams } from "expo-router";
import { StyleSheet, View } from "react-native";
import { OmniMark } from "@/components/brand/omni-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Text } from "@/components/ui/text.tsx";
import { signInInBrowser, useSession } from "@/lib/session.ts";
import { useSplashDone } from "@/lib/splash.ts";
import { gutter, space } from "@/theme/tokens.ts";

/** The welcome screen: Continue hands sign-in to the server's page in a browser sheet. */
export default function SignIn() {
  const session = useSession();
  const { error } = useLocalSearchParams<{ error?: string }>();
  const signIn = useMutation({ mutationFn: signInInBrowser });
  useSplashDone(!session.data);

  if (session.data) return <Redirect href="/mail" />;

  const failed = signIn.isError || signIn.data === "error" || (!!error && signIn.isIdle);
  return (
    <Screen>
      <View style={styles.body}>
        <View style={styles.heading}>
          <OmniMark />
          <View>
            <Text size="title" weight="medium" accessibilityRole="header">
              Welcome to Omni
            </Text>
            <Text size="title" tone="mutedForeground">
              Use or create your omni email to get started
            </Text>
          </View>
        </View>
        <Button
          size="lg"
          label={failed ? "Try again" : "Continue"}
          isPending={signIn.isPending}
          onPress={() => signIn.mutate()}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, paddingHorizontal: gutter, paddingBottom: space(4) },
  heading: { flex: 1, justifyContent: "center", gap: space(5) },
});
