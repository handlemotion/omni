import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { appToast } from "@/components/ui/toast";
import { useVerifySignInEmail } from "@/hooks/use-sign-in-emails.ts";

// Not from a Figma frame yet: laid out like the sign-in card, for the designer to replace.
/** Confirms the address once on arrival, then returns to settings. */
export function VerifySignInEmail({ token }: { token: string | undefined }) {
  const navigate = useNavigate();
  const verify = useVerifySignInEmail();
  const sent = useRef(false);

  useEffect(() => {
    // Once per page: the token is single-use, and React runs effects twice in development.
    if (!token || sent.current) return;
    sent.current = true;
    verify.mutate(token, {
      onSuccess: ({ email }) => {
        appToast.success(`You can now sign in with ${email}`);
        void navigate({ to: "/settings" });
      },
    });
  }, [token, verify, navigate]);

  const failure = !token ? "This link is incomplete." : verify.error?.message;
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface">
      {/* The bottom padding lifts the card a little above center, where it looks centered. */}
      <div className="flex w-100 flex-col pb-12">
        <Card className="gap-5 p-6">
          <Heading>{failure ? "Could not add this email" : "Adding your email"}</Heading>
          {failure && <Text>{failure}</Text>}
          {failure && (
            <Button intent="outline" size="lg" onPress={() => void navigate({ to: "/settings" })}>
              Back to settings
            </Button>
          )}
        </Card>
      </div>
    </main>
  );
}
