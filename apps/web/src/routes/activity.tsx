import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/activity")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/", search, replace: true });
  },
});
