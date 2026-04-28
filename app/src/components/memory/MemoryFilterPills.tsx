// === wave 21 ===
/**
 * Wave 21 — Filter pills for the /memory tree.
 *
 * Three pill groups:
 *   - Vendor pills (claude / cursor / chatgpt / ...) — click to toggle.
 *   - Date-range pill (Last 7d / 30d / 90d / All)
 *   - Search input that filters the tree by title-substring.
 *
 * Pure controlled component — parent owns the state.
 */

import { Search } from "lucide-react";
import { ALL_VENDOR_IDS, vendorColor, type VendorId } from "@/lib/vendor-colors";
import { cn } from "@/lib/utils";

export type DateRange = "7d" | "30d" | "90d" | "all";

interface Props {
  vendorFilter: Record<string, boolean>;
  onVendorToggle: (vendor: VendorId) => void;
  onVendorReset: () => void;
  dateRange: DateRange;
  onDateRangeChange: (r: DateRange) => void;
  search: string;
  onSearchChange: (s: string) => void;
}

const DATE_RANGE_LABELS: Record<DateRange, string> = {
  "7d": "Last 7d",
  "30d": "Last 30d",
  "90d": "Last 90d",
  all: "All time",
};

const DATE_RANGE_ORDER: DateRange[] = ["7d", "30d", "90d", "all"];

// Top vendors shown by default. The dropdown reveals the rest.
const TOP_VENDORS: VendorId[] = [
  "cursor",
  "claude-code",
  "claude-ai",
  "chatgpt",
  "codex",
];

export function MemoryFilterPills({
  vendorFilter,
  onVendorToggle,
  onVendorReset,
  dateRange,
  onDateRangeChange,
  search,
  onSearchChange,
}: Props) {
  const anyVendorActive = Object.values(vendorFilter).some(Boolean);
  return (
    <div data-testid="memory-filter-pills" className="space-y-2 px-3 py-2">
      <div className="relative">
        <Search
          size={11}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-stone-400"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Filter by title…"
          aria-label="Filter memory tree"
          data-testid="memory-filter-search"
          className="w-full rounded border border-stone-200 bg-white py-1 pl-6 pr-2 font-mono text-[11px] text-stone-700 outline-none focus:border-[var(--ti-orange-500)] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
        />
      </div>

      <div data-testid="memory-filter-vendors" className="flex flex-wrap items-center gap-1">
        <Pill
          active={!anyVendorActive}
          onClick={onVendorReset}
          testId="memory-filter-all-vendors"
        >
          All vendors
        </Pill>
        {TOP_VENDORS.filter((v) => ALL_VENDOR_IDS.includes(v)).map((v) => {
          const vc = vendorColor(v);
          const active = Boolean(vendorFilter[v]);
          const dotHex = vc.hex.startsWith("linear-gradient") ? "#A855F7" : vc.hex;
          return (
            <Pill
              key={v}
              active={active}
              onClick={() => onVendorToggle(v)}
              testId={`memory-filter-vendor-${v}`}
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: dotHex }}
              />
              <span className="truncate">{vc.label}</span>
            </Pill>
          );
        })}
      </div>

      <div data-testid="memory-filter-date" className="flex flex-wrap items-center gap-1">
        {DATE_RANGE_ORDER.map((r) => (
          <Pill
            key={r}
            active={dateRange === r}
            onClick={() => onDateRangeChange(r)}
            testId={`memory-filter-date-${r}`}
          >
            {DATE_RANGE_LABELS[r]}
          </Pill>
        ))}
      </div>
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] transition-colors duration-fast",
        active
          ? "border-[var(--ti-orange-500)]/50 bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:border-[var(--ti-orange-500)]/50 dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
          : "border-stone-200 bg-stone-50 text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800",
      )}
    >
      {children}
    </button>
  );
}
// === end wave 21 ===
