/**
 * v1.16 Wave 2 — round avatar with letter fallback. No network image —
 * we never reach out for gravatar/etc, every render works offline. The
 * background color hashes from the alias so two distinct teammates don't
 * collide visually.
 */

import { useMemo } from "react";

interface AvatarProps {
  alias: string;
  /** Pixel size — 32 for feed cards, 64 for /people detail. */
  size?: number;
}

/**
 * Stable color from alias — 12 brand-adjacent palette options. Avoid
 * Math.random / Date so SSR / vitest get the same color every time.
 */
function colorFor(alias: string): string {
  const palette = [
    "#cc5500", // ti-orange
    "#1a1a2e", // ti-deep-navy
    "#dc2626", // red
    "#ea580c", // orange
    "#d97706", // amber
    "#65a30d", // lime
    "#16a34a", // green
    "#0891b2", // cyan
    "#2563eb", // blue
    "#7c3aed", // violet
    "#c026d3", // fuchsia
    "#be185d", // pink
  ];
  let h = 0;
  for (let i = 0; i < alias.length; i++) {
    h = (h * 31 + alias.charCodeAt(i)) >>> 0;
  }
  return palette[h % palette.length];
}

export function Avatar({ alias, size = 32 }: AvatarProps) {
  const initial = useMemo(() => {
    const trimmed = (alias || "?").trim();
    return trimmed.length > 0 ? trimmed.charAt(0).toUpperCase() : "?";
  }, [alias]);
  const bg = useMemo(() => colorFor(alias || ""), [alias]);
  const fontSize = Math.round(size * 0.45);
  return (
    <div
      role="img"
      aria-label={`${alias} avatar`}
      data-testid={`avatar-${alias}`}
      style={{
        width: size,
        height: size,
        backgroundColor: bg,
        fontSize,
      }}
      className="ti-no-select inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
    >
      {initial}
    </div>
  );
}
