import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/agents")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/", search, replace: true });
  },
});
