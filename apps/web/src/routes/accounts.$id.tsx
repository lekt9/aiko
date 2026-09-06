import { createFileRoute, redirect } from "@tanstack/react-router";
export const Route = createFileRoute("/accounts/$id")({
  beforeLoad: ({ search, params }) => {
    throw redirect({
      to: "/",
      search: { ...search, login: params.id },
      replace: true,
    });
  },
});
