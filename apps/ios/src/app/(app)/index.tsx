import { StyleSheet, View } from "react-native";
import { Button } from "@/components/ui/button.tsx";
import { Screen } from "@/components/ui/screen.tsx";
import { Text } from "@/components/ui/text.tsx";
import { signOut, useSession } from "@/lib/session.ts";
import { space } from "@/theme/tokens.ts";

// Placeholder until the inbox lands (next layer): who is signed in, and a way out.
export default function Home() {
  const session = useSession();
  return (
    <Screen>
      <View style={styles.body}>
        <Text size="title" weight="semibold">
          {session.data?.user.email}
        </Text>
        <Button intent="plain" label="Sign out" onPress={() => void signOut()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({ body: { flex: 1, padding: space(6), gap: space(4) } });
