/**
 * Left column of LV-0 — agenda list synthesized from intents (topics).
 */
interface AgendaItem {
  alias: string;
  topics: string[];
}

export function AgendaList({ items }: { items: AgendaItem[] }) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-[var(--ti-ink-500)]">
        No locked intents — agenda will populate as participants run prep.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="agenda-list">
      {items.map((it) => (
        <section key={it.alias}>
          <h3 className="ti-section-label mb-2">{it.alias}</h3>
          <ul className="flex flex-col gap-1">
            {it.topics.length === 0 ? (
              <li className="text-xs text-[var(--ti-ink-500)]">(no topics)</li>
            ) : (
              it.topics.map((t, i) => (
                <li
                  key={`${it.alias}-${i}`}
                  className="rounded-md border border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-2 py-1.5 text-xs"
                >
                  {t}
                </li>
              ))
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}
