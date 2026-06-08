"use client";

import { useId } from "react";

/**
 * Canolite brand mark — a gradient app tile with a photo card (the rendered
 * image) and a sparkle (generation). Scales cleanly via the `size` prop.
 */
export function Logo({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const gid = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Canolite"
    >
      <defs>
        <linearGradient
          id={gid}
          x1="0"
          y1="0"
          x2="32"
          y2="32"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#3B82F6" />
          <stop offset="1" stopColor="#4F46E5" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gid})`} />
      {/* back card — a second generated output */}
      <rect
        x="9.5"
        y="7.5"
        width="12.5"
        height="12.5"
        rx="3"
        fill="#ffffff"
        fillOpacity="0.35"
      />
      {/* front card — the image */}
      <rect x="7" y="11" width="13.5" height="13.5" rx="3.2" fill="#ffffff" />
      {/* sun */}
      <circle cx="11.2" cy="15.2" r="1.7" fill={`url(#${gid})`} />
      {/* mountains */}
      <path
        d="M8 23.2 L12.2 17.8 L14.6 20.3 L16.2 18.4 L19.5 23.2 Z"
        fill={`url(#${gid})`}
      />
      {/* sparkle — generation */}
      <path
        d="M24 6 C24.3 8.2 25.3 9.2 27.5 9.5 C25.3 9.8 24.3 10.8 24 13 C23.7 10.8 22.7 9.8 20.5 9.5 C22.7 9.2 23.7 8.2 24 6 Z"
        fill="#ffffff"
      />
    </svg>
  );
}
