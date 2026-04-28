// === wave 1.13-A ===
/**
 * Wave 1.13-A — `<MentionInput/>`. A `<textarea>` that pops an @-mention
 * autocomplete dropdown when the user types `@` followed by 0+ alias
 * characters.
 *
 * Behaviour:
 *   * Type `@` → dropdown opens with the team roster (max 8 entries).
 *   * Keep typing → dropdown filters by prefix match against alias and
 *     display name.
 *   * Up / Down → cycle the highlighted suggestion.
 *   * Enter or Tab → insert the highlighted alias and close.
 *   * Escape → close without inserting.
 *   * Click outside → close.
 *
 * The component is uncontrolled-shaped: the parent passes `value` /
 * `onChange` like a regular `<textarea>`, gets back plain markdown
 * (`@username` syntax). The dropdown is rendered as a portal anchored at
 * the caret position so it never gets clipped by overflow:hidden ancestors
 * (z-index = 9999 to clear the AppShell toast layer).
 *
 * No new npm deps — we use Tailwind + the existing roster hook.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useTeamRoster, type TeamMember } from "@/lib/identity";

export interface MentionInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
  /** Override the roster (mainly for tests / Storybook). When omitted we
   *  read it via `useTeamRoster()`. */
  rosterOverride?: TeamMember[];
}

export interface MentionInputHandle {
  focus: () => void;
  blur: () => void;
}

const MAX_SUGGESTIONS = 8;

interface DropdownState {
  open: boolean;
  /** index of `@` in the textarea value (the start of the trigger). */
  startIdx: number;
  /** caret index. */
  caretIdx: number;
  /** Filter query (chars typed after `@`). */
  query: string;
  /** Highlighted suggestion index. */
  highlight: number;
  /** Anchor coords in viewport space. */
  top: number;
  left: number;
}

const CLOSED: DropdownState = {
  open: false,
  startIdx: -1,
  caretIdx: -1,
  query: "",
  highlight: 0,
  top: 0,
  left: 0,
};

/**
 * Determine whether the caret is currently inside an `@mention` token. If
 * so, return `{ startIdx, query }`; otherwise `null`. The token starts at
 * the `@` and ends at the caret. A token is invalid (and we close) when:
 *   * The character before `@` is alphanumeric (i.e. it's an email, not a
 *     mention).
 *   * The query contains a non-alias char (space, punctuation other than
 *     `_-`).
 */
function activeMentionAt(
  value: string,
  caret: number,
): { startIdx: number; query: string } | null {
  if (caret <= 0) return null;
  // Walk back from caret to find the most recent `@` on the same word.
  let i = caret;
  while (i > 0) {
    const ch = value[i - 1];
    if (ch === "@") {
      const before = i >= 2 ? value[i - 2] : "";
      if (/[A-Za-z0-9]/.test(before)) {
        // Email-like context; not a mention.
        return null;
      }
      const query = value.slice(i, caret);
      // Reject if the query contains any whitespace or banned punctuation.
      if (/[^A-Za-z0-9_-]/.test(query)) return null;
      return { startIdx: i - 1, query };
    }
    if (/\s/.test(ch)) return null;
    i--;
  }
  return null;
}

function rankSuggestions(roster: TeamMember[], query: string): TeamMember[] {
  const q = query.toLowerCase();
  if (q.length === 0) return roster.slice(0, MAX_SUGGESTIONS);
  const exact: TeamMember[] = [];
  const prefix: TeamMember[] = [];
  const sub: TeamMember[] = [];
  for (const m of roster) {
    const a = m.alias.toLowerCase();
    const d = (m.displayName ?? "").toLowerCase();
    if (a === q || d === q) {
      exact.push(m);
    } else if (a.startsWith(q) || d.startsWith(q)) {
      prefix.push(m);
    } else if (a.includes(q) || d.includes(q)) {
      sub.push(m);
    }
  }
  return [...exact, ...prefix, ...sub].slice(0, MAX_SUGGESTIONS);
}

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(
  function MentionInput(
    {
      value,
      onChange,
      onSubmit,
      placeholder,
      rows = 3,
      className,
      ariaLabel,
      testId,
      disabled,
      rosterOverride,
    },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const portalRef = useRef<HTMLDivElement | null>(null);
    const liveRoster = useTeamRoster();
    const roster = rosterOverride ?? liveRoster.roster;

    const [drop, setDrop] = useState<DropdownState>(CLOSED);

    useImperativeHandle(ref, () => ({
      focus: () => taRef.current?.focus(),
      blur: () => taRef.current?.blur(),
    }));

    const suggestions = useMemo(
      () => rankSuggestions(roster, drop.query),
      [roster, drop.query],
    );

    const closeDropdown = useCallback(() => setDrop(CLOSED), []);

    /** Compute the viewport coordinates for the dropdown. We use the
     * textarea's bounding rect + a hidden mirror div to estimate the caret
     * position. Cheap and deterministic. */
    const positionDropdown = useCallback((startIdx: number) => {
      const ta = taRef.current;
      if (!ta) return { top: 0, left: 0 };
      const rect = ta.getBoundingClientRect();
      // Approximation: anchor at the textarea's bottom-left. A pixel-perfect
      // caret tracker would need a mirror element; for the v1 collab MVP we
      // accept the slight imprecision in exchange for zero new deps.
      void startIdx;
      return {
        top: rect.bottom + window.scrollY + 4,
        left: rect.left + window.scrollX,
      };
    }, []);

    const refreshDropdown = useCallback(
      (nextValue: string, caret: number) => {
        const hit = activeMentionAt(nextValue, caret);
        if (!hit) {
          setDrop(CLOSED);
          return;
        }
        const { top, left } = positionDropdown(hit.startIdx);
        setDrop((prev) => ({
          open: true,
          startIdx: hit.startIdx,
          caretIdx: caret,
          query: hit.query,
          highlight: prev.open && prev.query === hit.query ? prev.highlight : 0,
          top,
          left,
        }));
      },
      [positionDropdown],
    );

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      const caret = e.target.selectionEnd ?? next.length;
      onChange(next);
      refreshDropdown(next, caret);
    };

    const handleSelect = useCallback(
      (alias: string) => {
        const ta = taRef.current;
        if (!ta) return;
        if (drop.startIdx < 0) return;
        const before = value.slice(0, drop.startIdx);
        const after = value.slice(drop.caretIdx);
        const insert = `@${alias} `;
        const next = `${before}${insert}${after}`;
        onChange(next);
        // Move caret to end of inserted token.
        const caret = before.length + insert.length;
        // Use a microtask so React flushes the value first.
        queueMicrotask(() => {
          if (taRef.current) {
            taRef.current.focus();
            taRef.current.setSelectionRange(caret, caret);
          }
        });
        closeDropdown();
      },
      [value, drop, onChange, closeDropdown],
    );

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (drop.open) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setDrop((d) => ({
            ...d,
            highlight: Math.min(d.highlight + 1, suggestions.length - 1),
          }));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setDrop((d) => ({ ...d, highlight: Math.max(d.highlight - 1, 0) }));
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (suggestions.length > 0) {
            e.preventDefault();
            handleSelect(suggestions[drop.highlight].alias);
            return;
          }
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeDropdown();
          return;
        }
      } else if (
        e.key === "Enter" &&
        !e.shiftKey &&
        (e.metaKey || e.ctrlKey) &&
        onSubmit
      ) {
        e.preventDefault();
        onSubmit();
      }
    };

    // Re-position the dropdown on window scroll / resize so it stays
    // anchored to the textarea.
    useLayoutEffect(() => {
      if (!drop.open) return;
      const handler = () => {
        if (drop.startIdx < 0) return;
        const { top, left } = positionDropdown(drop.startIdx);
        setDrop((d) => ({ ...d, top, left }));
      };
      window.addEventListener("scroll", handler, true);
      window.addEventListener("resize", handler);
      return () => {
        window.removeEventListener("scroll", handler, true);
        window.removeEventListener("resize", handler);
      };
    }, [drop.open, drop.startIdx, positionDropdown]);

    // Click outside the textarea + dropdown closes.
    useEffect(() => {
      if (!drop.open) return;
      const onDown = (e: MouseEvent) => {
        const t = e.target as Node | null;
        if (!t) return;
        if (taRef.current?.contains(t)) return;
        if (portalRef.current?.contains(t)) return;
        closeDropdown();
      };
      window.addEventListener("mousedown", onDown);
      return () => window.removeEventListener("mousedown", onDown);
    }, [drop.open, closeDropdown]);

    const portalNode =
      typeof document !== "undefined" && drop.open && suggestions.length > 0 ? (
        createPortal(
          <div
            ref={portalRef}
            data-testid="mention-dropdown"
            role="listbox"
            aria-label={ariaLabel ? `${ariaLabel} mentions` : "Mentions"}
            style={{
              position: "absolute",
              top: drop.top,
              left: drop.left,
              zIndex: 9999,
              minWidth: 200,
              maxWidth: 320,
            }}
            className="rounded-md border border-stone-200 bg-white text-[12px] shadow-lg dark:border-stone-700 dark:bg-stone-900"
          >
            <ul className="max-h-64 overflow-y-auto py-1">
              {suggestions.map((m, i) => {
                const active = i === drop.highlight;
                return (
                  <li key={m.alias} role="option" aria-selected={active}>
                    <button
                      type="button"
                      data-testid={`mention-option-${m.alias}`}
                      data-active={active}
                      onMouseEnter={() =>
                        setDrop((d) => ({ ...d, highlight: i }))
                      }
                      onMouseDown={(e) => {
                        // Prevent the textarea from losing focus before the
                        // click registers.
                        e.preventDefault();
                        handleSelect(m.alias);
                      }}
                      className={
                        "flex w-full items-center gap-2 px-2 py-1 text-left " +
                        (active
                          ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
                          : "text-stone-700 hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-stone-800")
                      }
                    >
                      <span className="font-mono text-[11px]">@{m.alias}</span>
                      {m.displayName && (
                        <span className="truncate text-[11px] text-stone-500 dark:text-stone-400">
                          · {m.displayName}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>,
          document.body,
        )
      ) : null;

    return (
      <>
        <textarea
          ref={taRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={(e) => {
            const caret = (e.currentTarget.selectionEnd ?? 0) as number;
            refreshDropdown(value, caret);
          }}
          onBlur={() => {
            // Defer close so a mousedown on the dropdown wins.
            window.setTimeout(() => {
              if (
                document.activeElement &&
                portalRef.current?.contains(document.activeElement as Node)
              ) {
                return;
              }
              closeDropdown();
            }, 100);
          }}
          rows={rows}
          placeholder={placeholder}
          aria-label={ariaLabel}
          data-testid={testId}
          disabled={disabled}
          className={
            className ??
            "w-full resize-none rounded-md border border-stone-200 bg-white px-3 py-2 text-[13px] text-stone-900 shadow-sm focus:border-[var(--ti-orange-500)] focus:outline-none focus:ring-1 focus:ring-[var(--ti-orange-500)] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          }
        />
        {portalNode}
      </>
    );
  },
);
// === end wave 1.13-A ===
