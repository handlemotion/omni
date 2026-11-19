import { Google, Microsoft } from "@ridemountainpig/svgl-react";
import { useRouter } from "@tanstack/react-router";
import { useRef, useState } from "react";
import signInTiles from "@/assets/sign-in-tiles.jpg";
import { IconOmniGlobe } from "@/components/icons";
import { IconKey } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { Link } from "@/components/ui/link";
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
const CONTROL_HEIGHT = "h-9";
const LEGAL_LINK = "text-foreground underline decoration-border underline-offset-2";

/** `callback`: a native app opened this page for its sign-in (`/login?callback=`). */
export function SignIn({ redirect, callback }: { redirect?: string; callback?: string }) {
  const router = useRouter();
  const magicLink = useSignInMagicLink();
  const passkey = useSignInPasskey();
  const methods = useSignInMethods();
  const google = useSignInGoogle();
  const [email, setEmail] = useState("");
  const lastSend = useRef<{ email: string; at: number } | null>(null);

  return (
    <main className="grid min-h-dvh bg-background lg:grid-cols-2">
      <div className="relative hidden overflow-hidden lg:block">
        <img src={signInTiles} alt="" className="absolute inset-0 size-full object-cover" />
      </div>

      <div className="flex items-center justify-center px-6 pb-24">
        <div className="flex w-full max-w-88 flex-col gap-10">
          <div className="flex flex-col items-center gap-6">
            <IconOmniGlobe size={32} className="text-brand-cream" />
            <Heading className="text-xl">Sign in to Omni</Heading>
          </div>

          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Button
                intent="outline"
                className={CONTROL_HEIGHT}
                isDisabled={!methods.data?.google}
                isPending={google.isPending}
                onPress={() => google.mutate({ redirect, callback })}
              >
                <Google aria-hidden />
                Continue with Google
              </Button>
              <Button intent="outline" className={CONTROL_HEIGHT} isDisabled>
                <Microsoft aria-hidden />
                Continue with Microsoft
              </Button>
              {!callback && (
                <Button
                  intent="outline"
                  className={CONTROL_HEIGHT}
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
                  Continue with a Passkey
                </Button>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Separator className="flex-1" />
              <span className="text-xs uppercase tracking-wide text-subtle-foreground">or</span>
              <Separator className="flex-1" />
            </div>

            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const last = lastSend.current;
                if (last?.email === email && Date.now() - last.at < RESEND_AFTER_MS) return;
                lastSend.current = { email, at: Date.now() };
                magicLink.mutate(
                  { email, redirect, callback },
                  { onError: () => (lastSend.current = null) },
                );
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
                <Input
                  size="lg"
                  className={CONTROL_HEIGHT}
                  placeholder={`email@${location.hostname}`}
                />
              </TextField>
              <Button type="submit" className={CONTROL_HEIGHT} isPending={magicLink.isPending}>
                Continue
              </Button>
            </form>

            <Text className="text-balance text-center text-xs/5 text-muted-foreground">
              By signing in, you agree to our <Link className={LEGAL_LINK}>Terms of Service</Link>{" "}
              and <Link className={LEGAL_LINK}>Privacy Policy</Link>.
            </Text>
          </div>
        </div>
      </div>
    </main>
  );
}
