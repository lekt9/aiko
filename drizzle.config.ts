import { defineConfig } from "drizzle-kit";

const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL or DIRECT_URL is required");

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: { url, ssl: "require" },
});
