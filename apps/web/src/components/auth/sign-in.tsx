import { Google } from "@ridemountainpig/svgl-react";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { AccountMenu } from "@/components/auth/account-menu";
import { IconArrowRight, IconKey } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Input, InputGroup } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { TextField } from "@/components/ui/text-field";
import { useSignInMagicLink, useSignInPasskey } from "@/hooks/use-session.ts";
import { safeRedirect } from "@/lib/session.ts";

// Figma: Omni, frame "/" (node 1:13).
export function SignIn({ redirect }: { redirect?: string }) {
  const router = useRouter();
  const magicLink = useSignInMagicLink();
  const passkey = useSignInPasskey();
  const [email, setEmail] = useState("");

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-surface">
      <Button
        intent="secondary"
        size="xs"
        isCircle
        className="absolute top-6 left-6 border-0"
        onPress={() =>
          router.history.canGoBack() ? router.history.back() : void router.navigate({ to: "/" })
        }
      >
        Go back
      </Button>

      {/* The bottom padding lifts the card a little above center, where it looks centered. */}
      <div className="flex h-94 w-75 flex-col pb-12">
        <Card className="flex-1 gap-0 p-2">
          <div className="flex h-8">
            <AccountMenu />
          </div>

          <div className="flex flex-1 items-center justify-center">
            <Heading>Sign in to Omni</Heading>
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
              {/* Not wired: auth has no Google provider yet. */}
              <Button intent="outline" size="sm" className="justify-start">
                <Google width={15} height={15} aria-hidden />
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
