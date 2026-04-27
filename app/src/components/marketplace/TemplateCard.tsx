import { Link } from "react-router-dom";
import { Star, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Template } from "@/lib/tauri";

/**
 * v3.5 §1.7 — One row in the marketplace listing grid. Renders the
 * template's badge (free / paid), author handle, vertical chip, and
 * install count. Clicking the card navigates to `/marketplace/:id`.
 *
 * Self-shipped templates (`author === "tangerine"`) get a different visual
 * treatment per spec §3.4 — "platform-curated" badge.
 */
export function TemplateCard({ template }: { template: Template }) {
  const isPlatformCurated = template.author === "tangerine";
  const isFree = template.price_cents === 0;
  return (
    <Link
      to={`/marketplace/${template.id}`}
      className={cn(
        "block rounded-md border border-stone-200 bg-white p-4 transition-shadow hover:shadow-sm",
        "dark:border-stone-800 dark:bg-stone-950",
      )}
      data-testid={`template-card-${template.id}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-medium text-stone-900 dark:text-stone-100">
            {template.name}
          </h3>
          <p className="mt-0.5 truncate text-[11px] text-stone-500 dark:text-stone-400">
            by {template.author}
            {isPlatformCurated && (
              <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-[var(--ti-orange-50)] px-1 py-0.5 text-[10px] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]">
                <Star size={10} className="shrink-0" />
                platform
              </span>
            )}
          </p>
        </div>
        <PriceBadge isFree={isFree} priceCents={template.price_cents} />
      </div>
      <p className="mt-2 line-clamp-2 text-[12px] leading-snug text-stone-600 dark:text-stone-400">
        {template.description}
      </p>
      <div className="mt-3 flex items-center gap-2 text-[10px] text-stone-500 dark:text-stone-400">
        <VerticalChip vertical={template.vertical} />
        <span className="font-mono">v{template.version}</span>
        <span className="ml-auto inline-flex items-center gap-1">
          <Download size={10} className="shrink-0" />
          {template.install_count}
        </span>
      </div>
    </Link>
  );
}

function PriceBadge({ isFree, priceCents }: { isFree: boolean; priceCents: number }) {
  if (isFree) {
    return (
      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
        Free
      </span>
    );
  }
  return (
    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-mono text-stone-700 dark:bg-stone-800 dark:text-stone-300">
      ${(priceCents / 100).toFixed(2)}
    </span>
  );
}

function VerticalChip({ vertical }: { vertical: string }) {
  return (
    <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[10px] capitalize text-stone-700 dark:bg-stone-800 dark:text-stone-300">
      {vertical}
    </span>
  );
}
