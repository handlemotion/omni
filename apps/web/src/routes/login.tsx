import { createFileRoute } from "@tanstack/react-router";
import { SignIn } from "../components/auth/sign-in.tsx";
import { redirectIfMember } from "../lib/guards.ts";
import { loginSearch } from "../lib/search-params.ts";

export const Route = createFileRoute("/login")({
  validateSearch: loginSearch,
  beforeLoad: ({ context, search }) => redirectIfMember(context.queryClient, search.redirect),
  component: Login,
});

function Login() {
  const { redirect } = Route.useSearch();
  return <SignIn redirect={redirect} />;
}
