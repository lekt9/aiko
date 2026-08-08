import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400","500","600","700"], variable: "--font-mono" });
export const metadata: Metadata = { title: "Cell \u00B7 Canvas", description: "Cell DAG rendered live from manifest + dynamic DB \u2014 reactive entries, subgraph = agent" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={mono.variable} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body>
        <div className="min-h-screen">
          <header className="sticky top-0 z-30 border-b border-os-border bg-os-bg/80 backdrop-blur supports-[backdrop-filter]:bg-os-bg/70">
            <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-4 px-6 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className="shrink-0 whitespace-nowrap font-mono text-[11px] font-bold uppercase tracking-[0.18em]">Cell</span>
                <span className="hidden min-w-0 truncate text-os-dim md:inline">\u2014 reactive canvas</span>
              </div>
              {/* N1b · Canonical SaaS three-section: wordmark-left · 4-6-link cluster · sign-in+CTA right → minimal inline rhythm for now */}
              <nav className="flex shrink-0 items-center gap-2 font-mono text-[11px]" aria-label="Primary">
                <a href="/" className="whitespace-nowrap rounded-sm-t border border-os-border px-2.5 py-1 outline-none transition-[border-color,background-color] duration-[var(--dur-short)] hover:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80">Graph</a>
                <a href="/api/cell" target="_blank" rel="noreferrer" className="whitespace-nowrap rounded-sm-t border border-os-border px-2.5 py-1 outline-none transition-[border-color] duration-[var(--dur-short)] hover:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80">/api/cell</a>
                <a href="/api/firings" target="_blank" rel="noreferrer" className="whitespace-nowrap rounded-sm-t border border-os-border px-2.5 py-1 outline-none transition-[border-color] duration-[var(--dur-short)] hover:border-[var(--border-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus)] focus-visible:outline-offset-2 active:opacity-80">/api/firings</a>
              </nav>
            </div>
          </header>
          <main className="mx-auto max-w-[1280px] px-6 pb-12 pt-6">{children}</main>
          {/* Ft2 · Inline single line — wordmark / links / credit */}
          <footer className="mx-auto max-w-[1280px] border-t border-os-hairline px-6 py-6">
            <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-os-dim">
              <span className="whitespace-nowrap font-semibold uppercase tracking-[0.14em] text-os-text">CELL</span>
              <span className="whitespace-nowrap">Fractal harness \u00B7 membrane + organelles + wiring</span>
              <span className="whitespace-nowrap tabular-nums">\u00A9 2026 Cell</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
