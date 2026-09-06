import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/connect")({
  validateSearch: (search: Record<string, unknown>): { recover?: string } => ({
    recover: typeof search.recover === "string" ? search.recover : undefined,
  }),
  beforeLoad: ({ search }) => {
    const { recover, ...rest } = search;
    throw redirect({
      to: "/",
      search: { ...rest, login: recover ?? rest.login },
      replace: true,
    });
  },
});
