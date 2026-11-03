import { IconChevronDown } from "@/components/icons";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import {
  useDeviceSessions,
  useSession,
  useSignOut,
  useSwitchAccount,
} from "@/hooks/use-session.ts";

/** The signed-in account, with the other accounts on this browser and sign out. */
export function AccountMenu() {
  const session = useSession();
  const devices = useDeviceSessions();
  const switchAccount = useSwitchAccount();
  const signOut = useSignOut();
  const user = session.data?.user;
  if (!user) return null;

  const others = (devices.data ?? []).filter(
    (d) => d.session.token !== session.data?.session.token,
  );
  return (
    <MenuTrigger>
      <Button intent="plain" size="sm" className="self-start">
        <Avatar size="icon" isSquare src={user.image ?? null} className="bg-muted" />
        <span className="flex items-center gap-1.5">
          {user.email}
          <IconChevronDown />
        </span>
      </Button>
      <Menu placement="bottom start">
        {others.map((d) => (
          <MenuItem key={d.session.token} onAction={() => switchAccount.mutate(d.session.token)}>
            {d.user.email}
          </MenuItem>
        ))}
        {others.length > 0 && <MenuSeparator />}
        <MenuItem onAction={() => signOut.mutate()}>Sign out</MenuItem>
      </Menu>
    </MenuTrigger>
  );
}
