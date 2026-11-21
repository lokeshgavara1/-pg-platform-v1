/**
 * PGPAL brand: the PG monogram with the marigold folded corner, and the wordmark.
 * Vector traced from brand/pgpal-logo-original.png. Colours come from CSS variables
 * (--logo-ink, --logo-accent) so the mark turns cream on green bars and in dark mode.
 */
export const BRAND_NAME = 'PGPAL';
export const BRAND_TAGLINE = 'PG & hostel management, made simple';

export function LogoMark({ size = 32, title = BRAND_NAME, className = '' }: { size?: number; title?: string; className?: string }) {
  return (
    <svg className={`logo-mark ${className}`} width={size} height={size * (104.9 / 108)} viewBox="-4 -4 108 104.9" role="img" aria-label={title}>
      <g transform="scale(1 0.969)">
        <g style={{ fill: 'var(--logo-ink, #1F4436)' }}>
          <rect x="0" y="0" width="18.5" height="100" rx="4.5" />
          <path d="M0 0 H42 A22 22 0 0 1 64 22 V35 A22 22 0 0 1 42 57 H25 V39 H38 A8 8 0 0 0 46 31 V26 A7 7 0 0 0 39 19 H0 Z" />
          <path d="M28 65.5 H46 V71 A12 12 0 0 0 58 83 H83 V65 H66 V47 H96 A4 4 0 0 1 100 51 V96 A4 4 0 0 1 96 100 H53 A25 25 0 0 1 28 75 Z" />
        </g>
        <path style={{ fill: 'var(--logo-accent, #D19442)' }} d="M61 0 H95 A5 5 0 0 1 100 5 V40 Q100 44 97.5 42.5 Z" />
      </g>
    </svg>
  );
}

/** Mark + "PGPAL" wordmark, with an optional app chip ("Owner", "Admin"). */
export function BrandLockup({ app, size = 30 }: { app?: string; size?: number }) {
  return (
    <span className="lockup">
      <LogoMark size={size} />
      <span className="wordmark">{BRAND_NAME}</span>
      {app && <span className="app-chip">{app}</span>}
    </span>
  );
}
