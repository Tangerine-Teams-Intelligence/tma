/**
 * v1.16 Wave 3 Agent C1 — Magic Moment Step 3.
 *
 * 4 IDE-tool checkboxes (Claude Code / Cursor / Codex / Windsurf).
 * Default: Claude Code + Cursor checked. Selection writes through to
 * the Wave 1 store via `togglePersonalAgent`. Per-tool state survives
 * cold launches (already wired into the persisted slice).
 *
 * Notes about copy:
 *   - "Tangerine 会读这些工具的本地对话日志. 100% 不上传." aligns with
 *     the on-device privacy rail; we never imply cloud upload here.
 *   - The Codex / Windsurf rows are unchecked by default because most
 *     dogfood users only run CC + Cursor. They can opt-in mid-flow.
 */

import { useState } from "react";
import { useStore } from "@/lib/store";

interface Step3SourcesProps {
  onConfirm: () => void;
  onSkip: () => void;
}

type IdeKey = "claude_code" | "cursor" | "codex" | "windsurf";

interface IdeRow {
  key: IdeKey;
  label: string;
  badge?: string;
}

const ROWS: IdeRow[] = [
  { key: "claude_code", label: "Claude Code", badge: "recommended" },
  { key: "cursor", label: "Cursor" },
  { key: "codex", label: "Codex" },
  { key: "windsurf", label: "Windsurf" },
];

export function Step3Sources({ onConfirm, onSkip }: Step3SourcesProps) {
  const togglePersonalAgent = useStore((s) => s.ui.togglePersonalAgent);
  // Local checkbox state — defaults Claude Code + Cursor true. We
  // intentionally do not seed from the persisted store: a returning
  // user would never see Step 3 (welcomed=true gate) and a fresh user
  // expects the default-on selection regardless of any stale flag.
  const [checked, setChecked] = useState<Record<IdeKey, boolean>>({
    claude_code: true,
    cursor: true,
    codex: false,
    windsurf: false,
  });

  function toggleKey(k: IdeKey) {
    setChecked((c) => ({ ...c, [k]: !c[k] }));
  }

  function handleConfirm() {
    // Persist every selection through to the store. The Rust side is
    // the long-term source of truth; this magic-moment write only
    // updates the in-memory mirror so the user sees their picks
    // reflected the moment they land in /feed. The Settings page (or
    // a follow-up wave) is responsible for the final daemon hook.
    for (const row of ROWS) {
      togglePersonalAgent(row.key, checked[row.key]);
    }
    onConfirm();
  }

  return (
    <section
      data-testid="magic-step3"
      role="dialog"
      aria-label="Tangerine onboarding step 3"
      className="flex h-full w-full flex-col items-center justify-center px-3 md:px-6"
    >
      <div className="w-full max-w-md">
        <h2 className="text-center text-xl font-semibold text-stone-100">
          要监听哪些工具?
        </h2>
        <p className="mt-3 text-center text-[13px] leading-relaxed text-stone-400">
          Tangerine 会读这些工具的本地对话日志. 100% 不上传.
        </p>
        <ul
          data-testid="magic-step3-list"
          className="mt-8 flex flex-col gap-2"
        >
          {ROWS.map((row) => {
            const isOn = checked[row.key];
            return (
              <li key={row.key}>
                <label
                  data-testid={`magic-step3-row-${row.key}`}
                  data-checked={isOn ? "true" : "false"}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-stone-700 bg-stone-900/60 px-4 py-3 transition-colors hover:border-[var(--ti-orange-500)]/40"
                >
                  <input
                    type="checkbox"
                    data-testid={`magic-step3-checkbox-${row.key}`}
                    checked={isOn}
                    onChange={() => toggleKey(row.key)}
                    className="h-4 w-4 cursor-pointer accent-[var(--ti-orange-500)]"
                  />
                  <span className="flex-1 text-sm text-stone-100">
                    {row.label}
                  </span>
                  {row.badge && (
                    <span className="rounded bg-[var(--ti-orange-500)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--ti-orange-500)]">
                      {row.badge}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            data-testid="magic-step3-confirm"
            onClick={handleConfirm}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-[var(--ti-orange-500)]/50 bg-[var(--ti-orange-500)]/15 px-4 py-2.5 text-sm font-medium text-[var(--ti-orange-500)] transition-colors hover:bg-[var(--ti-orange-500)]/25"
          >
            完成 →
          </button>
          <button
            type="button"
            data-testid="magic-step3-skip"
            onClick={onSkip}
            className="text-[11px] text-stone-500 underline-offset-2 hover:underline"
          >
            Skip
          </button>
        </div>
      </div>
    </section>
  );
}
