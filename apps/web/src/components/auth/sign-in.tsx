import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AccountMenu } from "@/components/auth/account-menu";
import { IconArrowRight, IconGoogle, IconKey } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import { useSession, useSignInMagicLink, useSignInPasskey } from "@/hooks/use-session.ts";
import { safeRedirect } from "@/lib/session.ts";

export function SignIn({ redirect, error }: { redirect?: string; error?: string }) {
  const router = useRouter();
  const session = useSession();
  const magicLink = useSignInMagicLink();
  const passkey = useSignInPasskey();
  const [email, setEmail] = useState("");

  const status = error
    ? { danger: true, text: `Couldn't sign you in: ${error}` }
    : magicLink.error || passkey.error
      ? { danger: true, text: (magicLink.error ?? passkey.error)?.message }
      : magicLink.isSuccess
        ? { danger: false, text: "Check your email for a sign-in link." }
        : session.data && !session.data.member
          ? { danger: false, text: "You're not a member of an organization yet." }
          : null;

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-background">
      {router.history.canGoBack() && (
        <Button
          intent="secondary"
          size="xs"
          isCircle
          className="absolute top-6 left-6 border-0"
          onPress={() => router.history.back()}
        >
          Go back
        </Button>
      )}

      {/* The bottom padding lifts the card a little above center, where it looks centered. */}
      <div className="flex h-94 w-75 flex-col pb-12">
        <Card className="flex-1 gap-0 p-2">
          <div className="flex h-8">
            <AccountMenu />
          </div>

          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-center">
            <Heading className="text-base">Sign in to Omni</Heading>
            {status && (
              <Text className={status.danger ? "text-danger-subtle-foreground" : undefined}>
                {status.text}
              </Text>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                magicLink.mutate({ email, redirect });
              }}
            >
              <TextField
                type="email"
                aria-label="Email"
                autoComplete="username webauthn"
                isRequired
                value={email}
                onChange={setEmail}
              >
                <InputGroup>
                  <Input placeholder={`email@${location.hostname}`} />
                  <Button
                    type="submit"
                    intent="secondary"
                    size="inset"
                    aria-label="Email me a sign-in link"
                    isPending={magicLink.isPending}
                  >
                    <IconArrowRight />
                  </Button>
                </InputGroup>
              </TextField>
            </form>

            <div className="flex items-center gap-2.5">
              <Separator className="flex-1" />
              <span className="text-xs text-muted-foreground">or</span>
              <Separator className="flex-1" />
            </div>

            <div className="flex flex-col gap-2">
              {/* Google sign-in is designed but not wired in auth yet. */}
              <Button intent="outline" size="sm" className="justify-start" isDisabled>
                <IconGoogle />
                Using Google
              </Button>
              <Button
                intent="outline"
                size="sm"
                className="justify-start"
                isPending={passkey.isPending}
                onPress={() =>
                  passkey.mutate(undefined, {
                    onSuccess: () => void router.history.push(safeRedirect(redirect)),
                  })
                }
              >
                <IconKey />
                Using a Passkey
              </Button>
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
