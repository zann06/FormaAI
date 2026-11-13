import { useId } from 'react';
import { Link } from 'react-router-dom';

/**
 * The FormaAI mark: a geometric "F" cut out of a rounded tile whose fill runs
 * deep blue → bubblegum pink. It is drawn as inline SVG so it stays crisp at any
 * size, inherits the page's colours, and needs no extra network request.
 *
 * The gradient id is generated per instance (`useId`), because two logos on one
 * page sharing a `<defs>` id makes the second one render with the first one's
 * gradient — or with none at all.
 */
export function LogoMark({ size = 28, className = '' }: { size?: number; className?: string }) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="FormaAI"
      className={className}
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#09318d" />
          <stop offset="55%" stopColor="#1f51c0" />
          <stop offset="100%" stopColor="#fd91cc" />
        </linearGradient>
      </defs>
      {/* Rounded tile: the "paper" the report is written on. */}
      <rect x="0" y="0" width="32" height="32" rx="9" fill={`url(#${gradientId})`} />
      {/* Geometric F, drawn as two bars so it reads cleanly at 16px. */}
      <path d="M10.5 22.5V9.5h12v3.4h-8.3v2.6h6.6v3.3h-6.6v3.7z" fill="#ffffff" />
      {/* Bubblegum accent dot: a small spark, matching the brand board. */}
      <circle cx="23.4" cy="22.4" r="2.6" fill="#fd91cc" />
    </svg>
  );
}

/** The wordmark: mark plus "FormaAI", with an optional link target. */
export function Logo({
  size = 28,
  to,
  variant = 'default',
  showWord = true,
  className = '',
}: {
  size?: number;
  to?: string;
  /** `inverted` is for use on top of the deep-blue hero. */
  variant?: 'default' | 'inverted';
  showWord?: boolean;
  className?: string;
}) {
  const content = (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      {showWord && (
        <span
          className={`text-[15px] font-semibold tracking-tight ${
            variant === 'inverted' ? 'text-white' : 'text-ink-900'
          }`}
        >
          Forma<span className={variant === 'inverted' ? 'text-accent-300' : 'text-brand-600'}>AI</span>
        </span>
      )}
    </span>
  );

  if (!to) return content;
  return (
    <Link to={to} className="rounded-lg transition-opacity hover:opacity-85 focus-visible:opacity-100">
      {content}
    </Link>
  );
}
