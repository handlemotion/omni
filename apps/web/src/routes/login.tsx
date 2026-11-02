// Placeholder UI: proves the sign-in wiring. Replace the markup freely; keep the hooks.
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useSession, useSignInMagicLink, useSignInPasskey } from "../hooks/use-session.ts";
import { redirectIfMember } from "../lib/guards.ts";
import { loginSearch } from "../lib/search-params.ts";
import { safeRedirect } from "../lib/session.ts";

export const Route = createFileRoute("/login")({
  validateSearch: loginSearch,
  beforeLoad: ({ context, search }) => redirectIfMember(context.queryClient, search.redirect),
  component: Login,
});

function Login() {
  const { redirect, error } = Route.useSearch();
  const router = useRouter();
  const session = useSession();
  const magicLink = useSignInMagicLink();
  const passkey = useSignInPasskey();
  const [email, setEmail] = useState("");

  return (
    <main>
      <h1>Sign in</h1>
      {error && <p>Error: {error}</p>}
      {session.data && !session.data.member && (
        <p>Signed in as {session.data.user.email}, but not a member of any organization yet.</p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          magicLink.mutate({ email, redirect });
        }}
      >
        <input
          type="email"
          autoComplete="username webauthn"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button type="submit" disabled={magicLink.isPending}>
          Email me a link
        </button>
      </form>
      {magicLink.isSuccess && <p>Check your email.</p>}
      {magicLink.error && <p>{magicLink.error.message}</p>}
      <button
        type="button"
        onClick={() =>
          passkey.mutate(undefined, {
            onSuccess: () => void router.history.push(safeRedirect(redirect)),
          })
        }
      >
        Sign in with a passkey
      </button>
      {passkey.error && <p>{passkey.error.message}</p>}
    </main>
  );
}
