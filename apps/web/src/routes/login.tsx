import { createFileRoute } from "@tanstack/react-router";
import { SignIn } from "../components/auth/sign-in.tsx";
import { redirectIfMember } from "../lib/guards.ts";
import { loginSearch } from "../lib/search-params.ts";
import { signInMethodsQuery } from "../lib/session.ts";

export const Route = createFileRoute("/login")({
  validateSearch: loginSearch,
  beforeLoad: ({ context, search }) => redirectIfMember(context.queryClient, search.redirect),
  // Known before render, so the Google button never pops in. A failure only hides the button.
  loader: ({ context }) => context.queryClient.prefetchQuery(signInMethodsQuery()),
  component: Login,
});

function Login() {
  const { redirect } = Route.useSearch();
  return <SignIn redirect={redirect} />;
}
