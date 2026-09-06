import { createFileRoute } from "@tanstack/react-router";
import { VaultSettings } from "../components/vault/settings";
export const Route = createFileRoute("/settings")({ component: VaultSettings });
