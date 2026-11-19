import { Stack, router } from "expo-router";

/**
 * The module header's bell, wearing your unread count as the web's notifications button does.
 * It opens Notifications in Mail's stack, where a notification's conversation opens on top.
 * Called, not mounted: the native header keeps only direct `Stack.Toolbar.*` elements.
 */
export function notificationsButton(unread: number) {
  return (
    <Stack.Toolbar.Button
      accessibilityLabel={unread ? `Notifications, ${unread} unread` : "Notifications"}
      onPress={() => router.push("/mail/notifications")}
    >
      <Stack.Toolbar.Icon sf="bell" />
      {unread ? (
        <Stack.Toolbar.Badge>{unread > 99 ? "99+" : String(unread)}</Stack.Toolbar.Badge>
      ) : null}
    </Stack.Toolbar.Button>
  );
}
