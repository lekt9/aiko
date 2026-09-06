import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/developers")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings", search, replace: true });
  },
});
