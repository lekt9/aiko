import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  noExternal: [/^@smthrs\/gateway-react$/, /^@smthrs\/gateway-client$/],
});
