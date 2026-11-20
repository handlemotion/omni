import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from "@expo-google-fonts/inter";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import * as Linking from "expo-linking";
import { Stack, router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { persistOptions, queryClient } from "@/lib/query-client.ts";
import { holdSplash } from "@/lib/splash.ts";
import { useDriveUploads } from "@/lib/drive-uploads.ts";
import { acceptSignInLink, useClearCacheOnUserChange, useSession } from "@/lib/session.ts";
import { colors } from "@/theme/tokens.ts";

holdSplash();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  useSignInLinks();
  useClearCacheOnUserChange();
  useDriveUploads(useSession().data?.user.id ?? null);
  if (!fontsLoaded) return null;
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
          <StatusBar style="dark" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            <Stack.Screen name="settings" options={{ presentation: "modal" }} />
          </Stack>
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function useSignInLinks() {
  const url = Linking.useLinkingURL();
  useEffect(() => {
    if (!url) return;
    const accept = async () => {
      const accepted = await acceptSignInLink(url);
      if (accepted) WebBrowser.dismissAuthSession();
      if (accepted === "error") {
        router.replace({ pathname: "/sign-in", params: { error: "link" } });
      }
    };
    void accept();
  }, [url]);
}

const styles = StyleSheet.create({ root: { flex: 1 } });
