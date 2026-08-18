import type { Metadata } from "next";
import { JetBrains_Mono, Inter } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400","500","600","700"], variable: "--font-mono" });
const ui = Inter({ subsets: ["latin"], weight: ["400","500","600","700"], variable: "--font-ui" });
export const metadata: Metadata = { title: "Aiko Flow · Cells", description: "n8n-style canvas over the Cell harness — every workflow is a *.cell.yaml, Aiko is resident in the editor" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${ui.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
