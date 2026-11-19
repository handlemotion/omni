import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClientProvider } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { queryClient } from "@/lib/query-client.ts";
import { acceptSignInLink, useClearCacheOnUserChange } from "@/lib/session.ts";
import { colors } from "@/theme/tokens.ts";

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  useSignInLinks();
  useClearCacheOnUserChange();
  if (!fontsLoaded) return null;
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        >
          <Stack.Screen name="settings" options={{ presentation: "modal" }} />
        </Stack>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function useSignInLinks() {
  const url = Linking.useLinkingURL();
  useEffect(() => {
    if (!url) return;
    const accept = async () => {
      if ((await acceptSignInLink(url)) === "error") {
        router.replace({ pathname: "/sign-in", params: { error: "link" } });
      }
    };
    void accept();
  }, [url]);
}
