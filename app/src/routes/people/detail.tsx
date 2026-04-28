import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, User } from "lucide-react";
import {
  readPerson,
  markAtomViewed,
  type PersonDetailData,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";
import { PersonView } from "@/components/PersonView";
// === v1.15.0 Wave 2.2 ===
import { EmptyStateCard } from "@/components/EmptyStateCard";

/**
 * /people/:alias — detail page. Loads readPerson(alias) and renders
 * <PersonView/>. Updates cursor.atoms_viewed when the user clicks an atom
 * row to drill in.
 */
export default function PersonDetailRoute() {
  const params = useParams();
  const alias = decodeURIComponent(params.alias ?? "");
  const currentUser = useStore((s) => s.ui.currentUser);
  // === v1.15.0 Wave 2.2 === — read W1.4's `firstAtomCapturedAt` flag
  // defensively (the field may not exist yet during the parallel ship).
  const firstAtomCapturedAt = useStore(
    (s) => (s.ui as unknown as { firstAtomCapturedAt?: string | null }).firstAtomCapturedAt ?? null,
  );
  const isFirstTime = firstAtomCapturedAt === null;
  const [data, setData] = useState<PersonDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  // === v1.13.8 round-8 === — readPerson re-throws on Tauri failure
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    if (!alias) return;
    setLoading(true);
    setError(null);
    readPerson(alias)
      .then((d) => {
        if (cancel) return;
        setData(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not read person.");
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [alias]);

  const onAtomViewed = (atomId: string) => {
    void markAtomViewed(currentUser, atomId);
  };

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/people"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> /people
          </Link>
        </div>

        <TangerineNotes
          notes={data?.notes ?? []}
          route={`people:${alias}`}
        />

        {loading ? (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">Loading…</p>
        ) : error ? (
          // === v1.13.8 round-8 === — armed error UI
          <div role="alert" data-testid="person-detail-error" className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 dark:border-rose-900 dark:bg-rose-950/30">
            <p className="text-[12px] text-rose-700 dark:text-rose-300">Couldn't read @{alias}.</p>
            <p className="mt-1 font-mono text-[10px] text-rose-600 dark:text-rose-400">{error}</p>
          </div>
        ) : data && data.recent_events.length > 0 ? (
          <PersonView data={data} onAtomViewed={onAtomViewed} />
        ) : (
          // === v1.15.0 Wave 2.2 === — first-time vs returning empty.
          // The "data exists but recent_events is empty" path used to
          // fall through to <PersonView/>'s own empty hint; for a fresh
          // user that hint just dead-ends. Surface the onboarding card
          // here for first-timers; keep the lighter line for returning
          // users so they aren't re-pitched setup steps they already ran.
          //
          // Either branch keeps an `@alias` heading above the empty
          // surface so existing smoke tests + screen-readers still find
          // the canonical alias on the page.
          <div data-testid="person-detail-empty">
            <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
              @{alias}
            </h1>
            {isFirstTime ? (
              <div className="mt-4">
                <EmptyStateCard
                  icon={<User size={24} />}
                  title={`No interactions with @${alias} yet`}
                  description="Capture an atom that mentions this teammate from your AI tool, and it will land here."
                  ctaLabel="Capture from your AI tool →"
                  ctaAction="/setup/connect"
                  telemetrySurface="people-detail"
                />
              </div>
            ) : (
              <p
                data-testid="person-detail-empty-returning"
                className="mt-4 text-[12px] text-stone-500 dark:text-stone-400"
              >
                No data for @{alias}.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
