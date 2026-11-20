import { useNavigate } from "@tanstack/react-router";
import { EmptyState } from "@/components/empty/empty-state";
import { Button } from "@/components/ui/button";
import { useConnectGoogle, useGoogleAccounts } from "@/hooks/use-google-connection";
import { useOnboarding } from "@/hooks/use-onboarding";

/**
 * The inbox before any account is connected, in the Personal space everyone starts in:
 * connect a Google account (it opens where its address belongs), or set up a company. Each only
 * where this person can: Google set up on the install, and a company theirs to create.
 */
export function NoInboxes() {
  const navigate = useNavigate();
  const google = useGoogleAccounts();
  const connect = useConnectGoogle("settings");
  const canConnect = google.data?.available === true;
  const canCreate = useOnboarding().data?.canCreateOrganization === true;
  return (
    <EmptyState figure="plug" title="No accounts yet">
      {canConnect && (
        <Button size="sm" isPending={connect.isPending} onPress={() => connect.mutate()}>
          Connect Google
        </Button>
      )}
      {canCreate && (
        <Button
          size="sm"
          intent={canConnect ? "outline" : "primary"}
          onPress={() => void navigate({ to: "/onboarding" })}
        >
          Set up a company
        </Button>
      )}
    </EmptyState>
  );
}
