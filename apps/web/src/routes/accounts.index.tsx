import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/accounts/")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/", search, replace: true });
  },
});
