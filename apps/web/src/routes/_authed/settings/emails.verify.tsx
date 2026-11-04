// The link mailed to a new sign-in email lands here. Any signed-in user may open it (no
// organization needed); a signed-out one signs in first and comes back. The token is sent by POST
// from this page, never on the link's GET, so a mail scanner opening the link spends nothing.
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
