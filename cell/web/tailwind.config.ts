import type { Config } from "tailwindcss";
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        os: {
          bg: "var(--bg)",
          bg2: "var(--bg-2)",
          surface: "var(--surface)",
          surface2: "var(--surface-2)",
          surface3: "var(--surface-3)",
          border: "var(--border)",
          hairline: "var(--hairline)",
          "border-strong": "var(--border-strong)",
          text: "var(--text)",
          muted: "var(--text-2)",
          dim: "var(--text-3)",
          accent: "var(--accent)",
          ink: "var(--accent-ink)",
          ok: "var(--ok)",
          warn: "var(--warn)",
          err: "var(--err)",
        },
      },
      fontFamily: {
        sans: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
        mono: ["var(--font-mono)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      borderRadius: { "sm-t": "0px", "md-t": "0px", "lg-t": "0px" },
    },
  },
  plugins: [],
};
export default config;
