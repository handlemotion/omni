import { createFileRoute } from "@tanstack/react-router";
import { VerifySignInEmail } from "../../../components/settings/verify-sign-in-email.tsx";
import { verifySignInEmailSearch } from "../../../lib/search-params.ts";

export const Route = createFileRoute("/_authed/settings/emails/verify")({
  validateSearch: verifySignInEmailSearch,
  component: Verify,
});

function Verify() {
  const { token } = Route.useSearch();
  return <VerifySignInEmail token={token} />;
}
