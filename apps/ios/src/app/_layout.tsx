import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts,
} from "@expo-google-fonts/inter";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack, useNavigationContainerRef, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as WebBrowser from "expo-web-browser";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBarBlur } from "@/components/ui/edge-blur.tsx";
import { persistOptions, queryClient } from "@/lib/query-client.ts";
import { holdSplash } from "@/lib/splash.ts";
import { useDriveUploads } from "@/lib/drive-uploads.ts";
import { useClearCacheOnUserChange, useSession } from "@/lib/session.ts";
import {
  initErrorReporting,
  registerNavigation,
  trackScreen,
  withErrorReporting,
} from "@/lib/telemetry.ts";
import { colors } from "@/theme/tokens.ts";

WebBrowser.maybeCompleteAuthSession();
initErrorReporting();
holdSplash();

export default withErrorReporting(RootLayout);

function RootLayout() {
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  useScreenTracking();
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
          <StatusBarBlur />
        </PersistQueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function useScreenTracking() {
  const navigation = useNavigationContainerRef();
  const pathname = usePathname();
  useEffect(() => {
    registerNavigation(navigation);
  }, [navigation]);
  useEffect(() => trackScreen(pathname), [pathname]);
}

const styles = StyleSheet.create({ root: { flex: 1 } });
