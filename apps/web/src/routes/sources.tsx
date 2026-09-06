import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/sources")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings", search, replace: true });
  },
});
