// The one "Connect Google" button, for setup's inbox step and Settings, Connected accounts. It
// leaves for Google's consent screen; Google comes back to the page named by `from`, which reads
// the outcome with `useGoogleReturn`.
import { Google } from "@ridemountainpig/svgl-react";
import { Button } from "@/components/ui/button";
import { useConnectGoogle } from "@/hooks/use-google-connection";
import type { GoogleReturn } from "@/lib/google-connection";

export function ConnectGoogleButton(props: {
  from: GoogleReturn;
  intent?: "primary" | "outline" | "ghost";
  label?: string;
  className?: string;
}) {
  const connect = useConnectGoogle(props.from);
  return (
    <Button
      intent={props.intent ?? "outline"}
      className={props.className}
      isPending={connect.isPending}
      onPress={() => connect.mutate()}
    >
      <Google aria-hidden />
      {props.label ?? "Connect Google"}
    </Button>
  );
}
