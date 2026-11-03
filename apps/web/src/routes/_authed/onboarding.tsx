import { createFileRoute } from "@tanstack/react-router";
import { Onboarding } from "../../components/onboarding/onboarding.tsx";

// Signed in, member of an organization or not: setup creates the first one.
export const Route = createFileRoute("/_authed/onboarding")({
  component: Onboarding,
});
