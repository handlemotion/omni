import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { IconRedirectArrow } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { appToast } from "@/components/ui/toast";
import { useSignOut } from "@/hooks/use-session.ts";
import { useAskToJoin, useJoin } from "@/hooks/use-join.ts";
import { keys } from "@/lib/query-keys.ts";

/**
 * A sign-in with a company's address whose person is not its member (ADR 0024): ask to join it,
 * or use another account. The sign-in card's frame (Figma: Omni, frame "/").
 */
export function Join() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const status = useJoin();
  const ask = useAskToJoin();
  useEffect(() => {
    if (!status.isError) return;
    client.removeQueries({ queryKey: keys.session() });
    void navigate({ to: "/" });
  }, [status.isError, client, navigate]);
  const signOut = useSignOut();
  const company = status.data?.company.name ?? "";
  const requested = status.data?.requested === true;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface">
      <div className="flex h-137.5 w-100 flex-col pb-12">
        <Card className="flex-1 justify-between gap-0 p-6">
          <div className="flex flex-col gap-5">
            <IconRedirectArrow />
            <Heading>{company ? `Join ${company}` : "Join"}</Heading>
          </div>
          <div className="flex flex-col gap-2">
            <Button
              size="lg"
              isDisabled={requested || !status.data}
              isPending={ask.isPending}
              onPress={() =>
                ask.mutate(undefined, {
                  onError: (error) => appToast.error(error.message || "The request was not sent."),
                })
              }
            >
              {requested ? "Requested" : "Ask to join"}
            </Button>
            <Button
              size="lg"
              intent="outline"
              isPending={signOut.isPending}
              onPress={() => signOut.mutate()}
            >
              Use another account
            </Button>
          </div>
        </Card>
      </div>
    </main>
  );
}
