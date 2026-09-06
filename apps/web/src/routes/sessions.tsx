import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/sessions")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/", search, replace: true });
  },
});
