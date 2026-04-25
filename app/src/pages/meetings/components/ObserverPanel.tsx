/**
 * Observer flag panel. Parses observations.md (one flag per `## ` block) and
 * renders cards. Used by both LV-0 and MD-0 → Observations tab.
 */
import { useMemo, useState } from "react";

interface Flag {
  id: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "error";
}

const SEVERITY_BORDER: Record<Flag["severity"], string> = {
  info: "#5B21B6",
  warn: "#B8860B",
  error: "#B83232",
};

function parseFlags(md: string): Flag[] {
  if (!md.trim()) return [];
  const blocks = md.split(/(?=^## )/m).filter((b) => b.trim().startsWith("## "));
  return blocks.map((blk, i) => {
    const lines = blk.split("\n");
    const heading = lines[0].replace(/^##\s+/, "").trim();
    const body = lines.slice(1).join("\n").trim();
    const sev: Flag["severity"] =
      /error|fail|conflict/i.test(heading)
        ? "error"
        : /warn|disagree/i.test(heading)
          ? "warn"
          : "info";
    return { id: `flag-${i}`, title: heading, body, severity: sev };
  });
}

interface Props {
  observationsMd: string;
  /** Optional silent/active mode toggle (LV-0 only). */
  showModeToggle?: boolean;
  mode?: "silent" | "active";
  onModeChange?: (m: "silent" | "active") => void;
}

export function ObserverPanel({
  observationsMd,
  showModeToggle,
  mode = "silent",
  onModeChange,
}: Props) {
  const flags = useMemo(() => parseFlags(observationsMd), [observationsMd]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  return (
    <div className="flex h-full flex-col gap-3" data-testid="observer-panel">
      {showModeToggle && (
        <div className="flex items-center gap-2 text-xs">
          <span className="ti-section-label">Observer mode</span>
          <button
            onClick={() => onModeChange?.("silent")}
            className={
              "rounded-md border px-2 py-1 " +
              (mode === "silent"
                ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                : "border-[var(--ti-border-default)] text-[var(--ti-ink-500)]")
            }
          >
            silent
          </button>
          <button
            onClick={() => onModeChange?.("active")}
            className={
              "rounded-md border px-2 py-1 " +
              (mode === "active"
                ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                : "border-[var(--ti-border-default)] text-[var(--ti-ink-500)]")
            }
            title="active mode reserved for v1.1"
          >
            active
          </button>
        </div>
      )}

      {flags.length === 0 ? (
        <p className="text-sm text-[var(--ti-ink-500)]">No observer flags yet.</p>
      ) : (
        <ul className="flex flex-col gap-2 overflow-auto">
          {flags.map((f) => {
            const isCollapsed = collapsed[f.id];
            return (
              <li
                key={f.id}
                data-testid={`flag-${f.id}`}
                className="rounded-md border bg-[var(--ti-paper-50)] p-3 text-sm shadow-sm animate-fade-in"
                style={{ borderLeftColor: SEVERITY_BORDER[f.severity], borderLeftWidth: 3 }}
              >
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [f.id]: !isCollapsed }))}
                  className="flex w-full items-start justify-between gap-2 text-left"
                >
                  <span className="font-medium">{f.title}</span>
                  <span className="text-xs text-[var(--ti-ink-500)]">
                    {isCollapsed ? "+" : "−"}
                  </span>
                </button>
                {!isCollapsed && (
                  <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-[var(--ti-ink-700)]">
                    {f.body}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
