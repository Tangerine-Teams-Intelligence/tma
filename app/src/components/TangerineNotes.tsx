import { Sparkles } from "lucide-react";
import type { TangerineNote } from "@/lib/views";

/**
 * Stage 2 hook §5 reserved area. Every view in /today /people /projects
 * /threads /alignment /inbox MUST mount this component at the top of the
 * page. Stage 1 ships with `notes = []` everywhere — the slot stays
 * mounted so when the Stage 2 reasoning loop pushes proactive insights
 * (thrash detection, drift warnings, decision drafts), the layout doesn't
 * shift and the UX feels consistent across the upgrade.
 *
 * Examples Stage 2 will populate here:
 *   /today              → "thrashing detected on pricing thread, suggest decision draft"
 *   /people/eric        → "Eric hasn't ack'd 5 decisions, here's a brief to send"
 *   /projects/v1-launch → "timeline slipping by 30%, here's what's blocking"
 *
 * Layout: orange left border, paper background. We ALWAYS render the
 * outer <section> so when notes flip from empty to populated the page
 * height changes only by the height of the cards — never by the section
 * boundary. In Stage 1 the empty state is invisible (no height) but the
 * mount point is preserved.
 */
export function TangerineNotes({
  notes,
  route: _route,
}: {
  notes: TangerineNote[];
  /** Route id ("today", "people:eric", etc.) — Stage 2 uses this to
   *  filter notes by surface. Stage 1 ignores it. */
  route: string;
}) {
  if (notes.length === 0) return null;
  return (
    <section
      data-tangerine-notes
      className="mb-6 space-y-2 border-l-4 border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] px-4 py-3 dark:bg-stone-900"
      aria-label="Tangerine notes"
    >
      <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]">
        <Sparkles size={11} />
        Tangerine notes
      </p>
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li
            key={n.id}
            className="text-[12px] leading-snug text-stone-700 dark:text-stone-300"
          >
            <span>{n.text}</span>
            {n.cta?.label && (
              <a
                href={n.cta.href ?? "#"}
                className="ml-2 font-medium text-[var(--ti-orange-700)] underline-offset-2 hover:underline dark:text-[var(--ti-orange-500)]"
              >
                {n.cta.label}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
