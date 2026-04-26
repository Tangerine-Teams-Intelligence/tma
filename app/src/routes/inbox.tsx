import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Inbox as InboxIcon,
  Clock,
  AlertTriangle,
  CheckCircle2,
  X,
} from "lucide-react";
import {
  readPendingAlerts,
  type PendingAlert,
  type TangerineNote,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";

/**
 * /inbox — pending alerts queue (real, not placeholder).
 *
 * Reads `<memory>/.tangerine/briefs/pending.md` parsed by the Tauri
 * `read_pending_alerts` command. Alerts come from the daemon's
 * `alert-detect` extension (stale decisions, overdue action items,
 * knowledge gaps).
 *
 * Each row supports three actions:
 *   • dismiss  — local hide (ui.dismissedAtoms)
 *   • snooze   — local defer for 24h (ui.snoozedAtoms)
 *   • resolve  — Stage 2 will mark the underlying atom acked. Stage 1
 *                only does the local dismiss + a console hint.
 */
export default function InboxRoute() {
  const dismissedAtoms = useStore((s) => s.ui.dismissedAtoms);
  const dismissAtom = useStore((s) => s.ui.dismissAtom);
  const snoozeAtom = useStore((s) => s.ui.snoozeAtom);
  const snoozedAtoms = useStore((s) => s.ui.snoozedAtoms);
  const [alerts, setAlerts] = useState<PendingAlert[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    void readPendingAlerts().then((d) => {
      if (cancel) return;
      setAlerts(d.alerts);
      setNotes(d.notes);
      setLoading(false);
    });
    return () => {
      cancel = true;
    };
  }, []);

  const visible = useMemo(() => {
    const now = Date.now();
    const dismissedSet = new Set(dismissedAtoms);
    return alerts.filter((a) => {
      if (dismissedSet.has(a.id)) return false;
      const snoozeUntil = snoozedAtoms[a.id];
      if (snoozeUntil && snoozeUntil > now) return false;
      return true;
    });
  }, [alerts, dismissedAtoms, snoozedAtoms]);

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/today"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> /today
          </Link>
        </div>

        <TangerineNotes notes={notes} route="inbox" />

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <InboxIcon size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">Inbox</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Pending alerts
            </h1>
            <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              {visible.length} active alert{visible.length === 1 ? "" : "s"} · daemon refresh ~5 min
            </p>
          </div>
        </header>

        <section className="mt-8 space-y-3">
          {loading ? (
            <p className="text-center text-[12px] text-stone-500 dark:text-stone-400">
              Loading…
            </p>
          ) : visible.length === 0 ? (
            <div className="rounded-md border border-dashed border-stone-300 p-8 text-center dark:border-stone-700">
              <CheckCircle2
                size={20}
                className="mx-auto text-emerald-600 dark:text-emerald-400"
              />
              <p className="mt-3 text-[12px] text-stone-700 dark:text-stone-300">
                Nothing pending. The daemon hasn't found stale decisions, overdue work, or
                knowledge gaps.
              </p>
            </div>
          ) : (
            visible.map((a) => (
              <AlertCard
                key={a.id}
                alert={a}
                onDismiss={() => dismissAtom(a.id)}
                onSnooze={() => snoozeAtom(a.id, Date.now() + 24 * 60 * 60_000)}
                onResolve={() => dismissAtom(a.id)}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function AlertCard({
  alert,
  onDismiss,
  onSnooze,
  onResolve,
}: {
  alert: PendingAlert;
  onDismiss: () => void;
  onSnooze: () => void;
  onResolve: () => void;
}) {
  const Icon = pickIcon(alert.kind, alert.severity);
  return (
    <div
      data-alert-card
      className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex items-start gap-3">
        <Icon
          size={14}
          className={
            alert.severity === "high"
              ? "text-rose-600 dark:text-rose-400"
              : alert.severity === "warn"
                ? "text-amber-600 dark:text-amber-400"
                : "text-stone-500 dark:text-stone-400"
          }
        />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
            {alert.title}
          </p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
            {alert.kind}
            {alert.due_at && (
              <span className="ml-2 normal-case tracking-normal">
                · due {alert.due_at}
              </span>
            )}
          </p>
          {alert.body && (
            <p className="mt-2 text-[12px] leading-relaxed text-stone-700 dark:text-stone-300">
              {alert.body}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          title="Dismiss"
          className="text-stone-400 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-200"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onSnooze}
          className="rounded border border-stone-200 px-2 py-0.5 font-mono text-[11px] text-stone-600 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          Snooze 24h
        </button>
        <button
          type="button"
          onClick={onResolve}
          className="rounded bg-[var(--ti-orange-500)] px-2 py-0.5 font-mono text-[11px] text-white hover:bg-[var(--ti-orange-600)]"
        >
          Resolve
        </button>
      </div>
    </div>
  );
}

function pickIcon(kind: string, severity?: string | null) {
  if (severity === "high") return AlertTriangle;
  if (kind === "stale" || kind === "overdue") return Clock;
  return InboxIcon;
}
