import { useMutation } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Text } from "@/components/ui/text.tsx";
import { TextField } from "@/components/ui/text-field.tsx";
import { config } from "@/lib/config.ts";
import { requestSignInLink, useSession } from "@/lib/session.ts";
import { space } from "@/theme/tokens.ts";

export default function SignIn() {
  const session = useSession();
  const { error } = useLocalSearchParams<{ error?: string }>();
  const [email, setEmail] = useState("");
  const link = useMutation({ mutationFn: requestSignInLink });

  if (session.data) return <Redirect href="/mail" />;

  const sentTo = link.isSuccess ? link.variables : undefined;
  return (
    <Screen>
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        <View style={styles.heading}>
          <Text size="title" weight="semibold">
            Welcome to Omni
          </Text>
          <Text tone="mutedForeground">Use or create your omni email to get started</Text>
        </View>
        <View style={styles.form}>
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            placeholder={`email@${new URL(config.apiUrl).hostname}`}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="username"
            returnKeyType="go"
            onSubmitEditing={() => email && link.mutate(email.trim())}
          />
          <Button
            size="lg"
            label={
              sentTo === email.trim()
                ? `Link sent to ${sentTo}`
                : link.isError || error
                  ? "Try again"
                  : "Continue"
            }
            isPending={link.isPending}
            disabled={!email.trim() || sentTo === email.trim()}
            onPress={() => link.mutate(email.trim())}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: space(8), padding: space(6) },
  heading: { gap: space(2), paddingTop: space(10) },
  form: { gap: space(2) },
});
