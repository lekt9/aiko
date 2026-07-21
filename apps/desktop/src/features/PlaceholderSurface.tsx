import type { LucideIcon } from "lucide-react";

interface PlaceholderSurfaceProps {
  title: string;
  description: string;
  icon: LucideIcon;
}

export function PlaceholderSurface({
  title,
  description,
  icon: Icon,
}: PlaceholderSurfaceProps) {
  return (
    <section className="surface placeholder-surface" aria-labelledby="placeholder-title">
      <div className="placeholder-surface__icon">
        <Icon size={22} aria-hidden="true" />
      </div>
      <h1 id="placeholder-title">{title}</h1>
      <p>{description}</p>
      <span>Native integration is staged in the active desktop plan.</span>
    </section>
  );
}
