// === wave 9 ===
/**
 * Wave 9 — "Borrow your AI" visual.
 *
 * Replaces the generic Sparkles icon on Welcome card 1 with an SVG that
 * tells the design moat #1 story in one glance: 4 vendor-colored arrows
 * point INWARD toward a Tangerine logo at center. The visual metaphor =
 * "your existing AI tools work FOR Tangerine; we don't take a new sub".
 *
 * The arrows pulse on hover via CSS keyframes (see ti-borrow-pulse in
 * index.css). Pure SVG, no JS animation.
 */

export function BorrowAIVisual({ size = 88 }: { size?: number }) {
  // Arrow geometry. Each arrow starts at one corner and points inward
  // toward the center. We compute the arrow tip 16px from center so it
  // doesn't overlap the orange logo circle (radius 14px).
  const c = size / 2;
  const corner = size * 0.12;
  const tipOffset = size * 0.22;

  // Arrow vector helper: returns a stroke + arrowhead pointing from
  // (sx,sy) → toward center, with the arrowhead tip at (tx,ty).
  const arrows = [
    {
      // top-left → center (Cursor blue)
      sx: corner,
      sy: corner,
      tx: c - tipOffset,
      ty: c - tipOffset,
      color: "#00A8E8",
      label: "Cursor",
    },
    {
      // top-right → center (Claude purple)
      sx: size - corner,
      sy: corner,
      tx: c + tipOffset,
      ty: c - tipOffset,
      color: "#5C2DC8",
      label: "Claude",
    },
    {
      // bottom-left → center (ChatGPT green)
      sx: corner,
      sy: size - corner,
      tx: c - tipOffset,
      ty: c + tipOffset,
      color: "#10A37F",
      label: "ChatGPT",
    },
    {
      // bottom-right → center (Codex amber)
      sx: size - corner,
      sy: size - corner,
      tx: c + tipOffset,
      ty: c + tipOffset,
      color: "#F59E0B",
      label: "Codex",
    },
  ];

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className="ti-borrow-svg"
      data-testid="borrow-ai-visual"
      role="img"
      aria-label="Your existing AI tools converging into Tangerine"
    >
      {/* Each vendor arrow */}
      {arrows.map((a, i) => (
        <g
          key={i}
          className="ti-borrow-arrow"
          style={
            {
              ["--ti-arrow-tx" as string]: `${(a.tx - a.sx) * 0.2}px`,
              ["--ti-arrow-ty" as string]: `${(a.ty - a.sy) * 0.2}px`,
            } as React.CSSProperties
          }
        >
          {/* Stroke */}
          <line
            x1={a.sx}
            y1={a.sy}
            x2={a.tx}
            y2={a.ty}
            stroke={a.color}
            strokeWidth="2"
            strokeLinecap="round"
          />
          {/* Arrowhead = small filled triangle at the tip */}
          <ArrowHead x={a.tx} y={a.ty} sx={a.sx} sy={a.sy} color={a.color} />
        </g>
      ))}
      {/* Central Tangerine logo */}
      <circle
        cx={c}
        cy={c}
        r={size * 0.16}
        fill="url(#ti-borrow-orange)"
        stroke="#A03F00"
        strokeWidth="1"
      />
      <text
        x={c}
        y={c + size * 0.05}
        textAnchor="middle"
        fontFamily="Fraunces, EB Garamond, Georgia, serif"
        fontSize={size * 0.18}
        fontWeight="600"
        fill="#FFFFFF"
      >
        T
      </text>
      <defs>
        <radialGradient id="ti-borrow-orange" cx="0.35" cy="0.30" r="0.85">
          <stop offset="0%" stopColor="#FFB477" />
          <stop offset="55%" stopColor="#CC5500" />
          <stop offset="100%" stopColor="#A03F00" />
        </radialGradient>
      </defs>
    </svg>
  );
}

/** Tiny filled triangle at the tip of each arrow, oriented along the
 *  source→tip vector. We compute the perpendicular so the triangle base
 *  spans 6px across the line. */
function ArrowHead({
  x,
  y,
  sx,
  sy,
  color,
}: {
  x: number;
  y: number;
  sx: number;
  sy: number;
  color: string;
}) {
  const dx = x - sx;
  const dy = y - sy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Step back a tiny amount from tip so the triangle body sits on the
  // line, then take perpendicular to draw the base.
  const back = 4;
  const baseX = x - ux * back;
  const baseY = y - uy * back;
  const half = 3;
  const px = -uy * half;
  const py = ux * half;
  const p1 = `${x},${y}`;
  const p2 = `${baseX + px},${baseY + py}`;
  const p3 = `${baseX - px},${baseY - py}`;
  return <polygon points={`${p1} ${p2} ${p3}`} fill={color} />;
}

export default BorrowAIVisual;
// === end wave 9 ===
