import { Google } from "@ridemountainpig/svgl-react";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { IconRedirectArrow } from "@/components/icons";
import { IconKey } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { TextField } from "@/components/ui/text-field";
import {
  useSignInGoogle,
  useSignInMagicLink,
  useSignInMethods,
  useSignInPasskey,
} from "@/hooks/use-session.ts";
import { isServerPath, safeRedirect } from "@/lib/session.ts";

const RESEND_AFTER_MS = 30_000;

export function SignIn({ redirect }: { redirect?: string }) {
  const router = useRouter();
  const magicLink = useSignInMagicLink();
  const passkey = useSignInPasskey();
  const methods = useSignInMethods();
  const google = useSignInGoogle();
  const [email, setEmail] = useState("");
  const lastSend = useRef<{ email: string; at: number } | null>(null);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface">
      <div className="flex h-137.5 w-100 flex-col pb-12">
        <Card className="flex-1 justify-between gap-0 p-6">
          <div className="flex flex-col gap-5">
            <IconRedirectArrow />
            <div className="flex flex-col gap-2">
              <Heading>Welcome to Omni</Heading>
              <Text>Use or create your omni email to get started</Text>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const last = lastSend.current;
                if (last?.email === email && Date.now() - last.at < RESEND_AFTER_MS) return;
                lastSend.current = { email, at: Date.now() };
                magicLink.mutate({ email, redirect }, { onError: () => (lastSend.current = null) });
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
                <Input size="lg" placeholder={`email@${location.hostname}`} />
              </TextField>
              <Button type="submit" size="lg" isPending={magicLink.isPending}>
                Continue
              </Button>
            </form>

            <div className="flex items-center gap-2.5">
              <Separator className="flex-1" />
              <span className="text-xs text-subtle-foreground">or</span>
              <Separator className="flex-1" />
            </div>

            <div className="flex flex-col gap-2">
              <Button
                intent="outline"
                size="lg"
                className="justify-start"
                isPending={passkey.isPending}
                onPress={() =>
                  passkey.mutate(undefined, {
                    onSuccess: () => {
                      const to = safeRedirect(redirect);
                      if (isServerPath(to)) window.location.assign(to);
                      else router.history.push(to);
                    },
                  })
                }
              >
                <IconKey />
                Using a Passkey
              </Button>
              {methods.data?.google && (
                <Button
                  intent="outline"
                  size="lg"
                  className="justify-start"
                  isPending={google.isPending}
                  onPress={() => google.mutate({ redirect })}
                >
                  <Google aria-hidden />
                  Using Google
                </Button>
              )}
            </div>
          </div>
        </Card>
      </div>
    </main>
  );
}
