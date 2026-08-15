/**
 * Composer shell marker component — domain boundary for slash/draft/attachments UI.
 * AppWorkbench still renders the full composer chrome; this module is the extraction
 * anchor for further vertical slices (WP-B2+).
 */
import type { ReactNode } from "react";

export type ComposerShellProps = {
  children: ReactNode;
  className?: string;
};

export function ComposerShell({ children, className }: ComposerShellProps) {
  return (
    <div className={className ?? "composer-shell"} data-domain="composer">
      {children}
    </div>
  );
}
