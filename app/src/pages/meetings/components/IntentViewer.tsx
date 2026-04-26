/**
 * Renders intents/<alias>.md cards. Markdown is shown literal (Tangerine voice:
 * raw text > syntax-highlighted; user gets exactly what's on disk).
 */
import { Card } from "@/components/ui/card";

interface Intent {
  alias: string;
  ready: boolean;
  markdown?: string;
}

export function IntentViewer({ intents }: { intents: Intent[] }) {
  if (intents.length === 0) {
    return (
      <p className="text-sm text-[var(--ti-ink-500)]">
        No intents yet. Run prep for each participant before starting.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2" data-testid="intent-viewer">
      {intents.map((it) => (
        <Card key={it.alias} className="p-4" data-testid={`intent-card-${it.alias}`}>
          <div className="flex items-center justify-between">
            <h3 className="font-display text-lg">{it.alias}</h3>
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs " +
                (it.ready
                  ? "bg-[#D1FAE5] text-[#065F46]"
                  : "bg-[#FEF3C7] text-[#92400E]")
              }
            >
              {it.ready ? "locked" : "pending"}
            </span>
          </div>
          {it.markdown ? (
            <pre className="mt-3 whitespace-pre-wrap font-mono text-xs text-[var(--ti-ink-700)] leading-relaxed">
              {it.markdown}
            </pre>
          ) : (
            <p className="mt-3 text-sm text-[var(--ti-ink-500)]">No intent file yet.</p>
          )}
        </Card>
      ))}
    </div>
  );
}
