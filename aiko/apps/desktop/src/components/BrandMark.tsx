interface BrandMarkProps {
  compact?: boolean;
}

export function BrandMark({ compact = false }: BrandMarkProps) {
  return (
    <div className="brand" aria-label="Aiko">
      <svg
        className="brand__mark"
        viewBox="0 0 32 32"
        role="img"
        aria-hidden="true"
      >
        <path d="M4.5 26 13 6h4.2L8.9 26H4.5Z" />
        <path d="m15.4 6 3.9.1L27.7 26h-4.8l-3-7.5h-7.1l1.6-3.9h4L15.4 6Z" />
        <rect className="brand__spark" x="23.4" y="5.8" width="3.8" height="3.8" rx="1.2" />
      </svg>
      {!compact && <span className="brand__word">aiko</span>}
    </div>
  );
}
