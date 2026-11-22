import { createFileRoute } from "@tanstack/react-router";
import { MeetingsHome } from "../../../components/meetings/group-page.tsx";

export const Route = createFileRoute("/_authed/$workspace/meetings/")({
  component: MeetingsHome,
});
