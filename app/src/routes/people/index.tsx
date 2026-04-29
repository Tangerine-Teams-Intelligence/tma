/**
 * v1.16 Wave 2 Agent B3 — /people People grid (REWRITE).
 *
 * Use case: future-hire onboarding. New teammate opens Tangerine on
 * day one and at a glance sees "who has been active, what are they
 * working on" before filing into project / threads detail.
 *
 * v1.16 Wave 1 砍 the LLM smart layer; this surface is pure
 * capture-derived aggregation:
 *   - Read atoms via readTimelineRecent(500).
 *   - Group by `actor` to build a PersonStats row per unique alias.
 *   - For each person: count last-24h atoms, extract top 3 hashtags
 *     (concepts + body `#tag` regex), latest timestamp.
 *   - Click a person → filter the AtomCard list shown below to that
 *     actor only (max 50, desc by ts).
 *
 * Default selection = currentUser (zustand store). Empty state
 * fires only when the user is solo (only their own alias appears) —
 * we still show their own card and a "Invite a teammate" CTA.
 *
 * R6/R7/R8 honesty: loading + error states are explicit. We never
 * paint a populated grid with mock teammates.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  readTimelineRecent,
  type TimelineEvent,
  type TangerineNote,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { ViewTabs } from "@/components/layout/ViewTabs";
import { AtomCard } from "@/components/feed/AtomCard";
import { TangerineNotes } from "@/components/TangerineNotes";
import { PersonCard, type PersonStats } from "@/components/people/PersonCard";
import { EmptyStateAnimation } from "@/components/onboarding/EmptyStateAnimation";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const MAX_FILTERED_ATOMS = 50;
/** Body text matches `#tag` for hashtag detection. Mirrors the regex
 *  used by AtomCard's @mention detection so we stay consistent. */
const HASHTAG_RE = /#([a-z0-9][a-z0-9_-]*)/gi;

export default function PeopleListRoute() {
  const currentUser = useStore((s) => s.ui.currentUser);
  const navigate = useNavigate();
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    readTimelineRecent(500)
      .then((d) => {
        if (cancel) return;
        setEvents(d.events);
        setNotes(d.notes);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setLoading(false);
        setError(
          typeof e === "string"
            ? e
            : (e as Error)?.message ?? "Could not read recent timeline.",
        );
      });
    return () => {
      cancel = true;
    };
  }, []);

  const people = useMemo(() => buildPeopleStats(events), [events]);

  // Default selection = currentUser. If the current user has no atoms
  // yet (fresh install), fall back to the first person in the grid.
  const effectiveSelected = useMemo(() => {
    if (selected && people.some((p) => p.alias === selected)) return selected;
    const cu = currentUser.toLowerCase();
    if (people.some((p) => p.alias.toLowerCase() === cu)) return cu;
    return people.length > 0 ? people[0].alias : null;
  }, [selected, people, currentUser]);

  const activeCount = useMemo(
    () => people.filter((p) => p.countToday > 0).length,
    [people],
  );

  const filteredAtoms = useMemo(() => {
    if (!effectiveSelected) return [];
    const sel = effectiveSelected.toLowerCase();
    return events
      .filter((ev) => (ev.actor || "").toLowerCase() === sel)
      .slice()
      .sort((a, b) => Date.parse(b.ts || "") - Date.parse(a.ts || ""))
      .slice(0, MAX_FILTERED_ATOMS);
  }, [events, effectiveSelected]);

  // Empty state = solo user (only own alias OR 0 people total). We
  // still want to show the user their own card if it exists, but the
  // CTA appears when there are no teammates to compare to.
  const isSolo =
    !loading &&
    !error &&
    (people.length === 0 ||
      (people.length === 1 &&
        people[0].alias.toLowerCase() === currentUser.toLowerCase()));

  return (
    <div
      data-testid="people-route"
      className="flex h-full flex-col bg-stone-50 dark:bg-stone-950"
    >
      <ViewTabs />
      <main className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto max-w-5xl">
          {notes.length > 0 && <TangerineNotes notes={notes} route="/people" />}

          <header className="mb-6">
            <h1
              data-testid="people-header"
              className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100"
            >
              People
              <span
                className="ml-2 font-mono text-[12px] font-normal text-stone-500 dark:text-stone-400"
                data-testid="people-active-count"
              >
                · {activeCount} active in last 24h
              </span>
            </h1>
          </header>

          {loading && (
            <div
              data-testid="people-loading"
              className="flex items-center justify-center py-16 text-stone-500"
            >
              <span className="font-mono text-[12px]">Loading people…</span>
            </div>
          )}

          {error && !loading && (
            <div
              data-testid="people-error"
              role="alert"
              className="rounded-md border border-rose-300 bg-rose-50 p-4 text-[13px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
            >
              <div className="font-semibold">Couldn't load people.</div>
              <div className="mt-1 font-mono text-[11px]">{error}</div>
            </div>
          )}

          {!loading && !error && (
            <>
              {people.length > 0 && (
                <section
                  data-testid="people-grid"
                  data-count={people.length}
                  className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
                >
                  {people.map((p) => (
                    <PersonCard
                      key={p.alias}
                      person={p}
                      selected={p.alias === effectiveSelected}
                      onSelect={setSelected}
                    />
                  ))}
                </section>
              )}

              {isSolo && (
                <>
                  {/* v1.16 Wave 3 C2 — render the animated 5-sample
                      preview above the solo CTA so the user sees
                      "teammates show up like this" before the invite
                      pitch. The legacy CTA is preserved verbatim so the
                      Wave 2 B3 spec (which queries `people-empty-solo`
                      + `people-empty-cta`) keeps passing. */}
                  <div className="mt-6">
                    <EmptyStateAnimation variant="people" />
                  </div>
                  <div
                    data-testid="people-empty-solo"
                    className="mt-8 flex flex-col items-center justify-center rounded-md border border-dashed border-stone-300 bg-white px-6 py-10 text-center dark:border-stone-700 dark:bg-stone-900"
                  >
                    <div className="text-[14px] font-semibold text-stone-700 dark:text-stone-200">
                      Invite a teammate to share memory
                    </div>
                    <p className="mt-2 max-w-md text-[12px] text-stone-500 dark:text-stone-400">
                      Tangerine becomes useful with two or more people. Set up
                      sync to share captured atoms with your team.
                    </p>
                    <button
                      type="button"
                      data-testid="people-empty-cta"
                      onClick={() => navigate("/settings/sync")}
                      className="mt-4 rounded-md bg-[var(--ti-orange-500)] px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-[var(--ti-orange-700)]"
                    >
                      Set up team sync
                    </button>
                  </div>
                </>
              )}

              {effectiveSelected && filteredAtoms.length > 0 && (
                <section className="mt-8">
                  <h2
                    className="mb-3 font-mono text-[11px] uppercase tracking-wider text-stone-500 dark:text-stone-400"
                    data-testid="people-filtered-heading"
                  >
                    Recent atoms · {effectiveSelected}
                  </h2>
                  <ol
                    data-testid="people-filtered-list"
                    data-count={filteredAtoms.length}
                    data-actor={effectiveSelected}
                    className="space-y-2"
                  >
                    {filteredAtoms.map((ev) => (
                      <li key={ev.id}>
                        <AtomCard event={ev} />
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              {effectiveSelected && filteredAtoms.length === 0 && people.length > 0 && (
                <div
                  data-testid="people-filtered-empty"
                  className="mt-8 rounded-md border border-stone-200 bg-white px-4 py-6 text-center text-[12px] text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400"
                >
                  No atoms from {effectiveSelected} yet.
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/**
 * Aggregate atoms into one PersonStats row per unique actor.
 *
 * - countToday: atoms whose ts is within the last 24h.
 * - hashtags: top 3 by frequency across concepts[] AND body `#tag`
 *   regex matches. Concepts are already curated (lowercase), so we
 *   feed them in directly. Body matches are lowercased for stable
 *   counting.
 * - latestTs: max(ts) across the actor's atoms.
 *
 * Sorted by countToday desc, then by latestTs desc as tiebreak — so
 * the most-active teammate lands top-left in the grid.
 */
export function buildPeopleStats(events: TimelineEvent[]): PersonStats[] {
  const cutoff = Date.now() - TWENTY_FOUR_HOURS_MS;
  const byActor = new Map<
    string,
    { countToday: number; tagCounts: Map<string, number>; latestTs: string | null }
  >();
  for (const ev of events) {
    const actor = (ev.actor || "").trim();
    if (!actor) continue;
    const key = actor.toLowerCase();
    let entry = byActor.get(key);
    if (!entry) {
      entry = { countToday: 0, tagCounts: new Map(), latestTs: null };
      byActor.set(key, entry);
    }
    const tsMs = Date.parse(ev.ts || "");
    if (!Number.isNaN(tsMs) && tsMs >= cutoff) entry.countToday += 1;
    if (entry.latestTs === null || (ev.ts && ev.ts > entry.latestTs)) {
      entry.latestTs = ev.ts ?? entry.latestTs;
    }
    for (const c of ev.concepts ?? []) {
      const t = (c || "").trim().toLowerCase();
      if (t) entry.tagCounts.set(t, (entry.tagCounts.get(t) ?? 0) + 1);
    }
    const body = ev.body ?? "";
    for (const m of body.matchAll(HASHTAG_RE)) {
      const t = m[1].toLowerCase();
      if (t) entry.tagCounts.set(t, (entry.tagCounts.get(t) ?? 0) + 1);
    }
  }
  const rows: PersonStats[] = [];
  for (const [alias, entry] of byActor.entries()) {
    const hashtags = [...entry.tagCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([t]) => t);
    rows.push({
      alias,
      countToday: entry.countToday,
      hashtags,
      latestTs: entry.latestTs,
    });
  }
  rows.sort(
    (a, b) =>
      b.countToday - a.countToday ||
      Date.parse(b.latestTs ?? "") - Date.parse(a.latestTs ?? ""),
  );
  return rows;
}
