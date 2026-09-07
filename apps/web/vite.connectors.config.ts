import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({ root: resolve(import.meta.dirname, "connector-site"), publicDir: resolve(import.meta.dirname, "public"), plugins: [react()], build: { outDir: resolve(import.meta.dirname, "../agent/public"), emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, "connector-site/connect.html") } } });
