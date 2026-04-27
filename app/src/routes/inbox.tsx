// === wave 5-α ===
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";

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
  const { t } = useTranslation();
  const dismissedAtoms = useStore((s) => s.ui.dismissedAtoms);
  const dismissAtom = useStore((s) => s.ui.dismissAtom);
  const snoozeAtom = useStore((s) => s.ui.snoozeAtom);
  const snoozedAtoms = useStore((s) => s.ui.snoozedAtoms);
  const [alerts, setAlerts] = useState<PendingAlert[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    let cancel = false;
    readPendingAlerts()
      .then((d) => {
        if (cancel) return;
        setAlerts(d.alerts);
        setNotes(d.notes);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not read pending alerts.");
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  };

  useEffect(() => {
    return refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            <ArrowLeft size={12} /> {t("inbox.back")}
          </Link>
        </div>

        <TangerineNotes notes={notes} route="inbox" />

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <InboxIcon size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">{t("inbox.kicker")}</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              {t("inbox.title")}
            </h1>
            <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              {visible.length === 1
                ? t("inbox.countOne", { count: visible.length })
                : t("inbox.countOther", { count: visible.length })}
            </p>
          </div>
        </header>

        <section className="mt-8 space-y-3" aria-live="polite" aria-busy={loading}>
          {loading ? (
            <div className="space-y-3" data-testid="inbox-loading">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900"
                >
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="mt-2 h-3 w-1/4" />
                  <Skeleton className="mt-3 h-3 w-full" />
                </div>
              ))}
            </div>
          ) : error ? (
            <ErrorState
              error={error}
              title={t("inbox.errorTitle")}
              onRetry={refresh}
              retryLabel={t("buttons.retry")}
              testId="inbox-error"
            />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={32} className="text-[var(--ti-success)]" />}
              title={t("inbox.emptyTitle")}
              description={t("inbox.emptyBody")}
              testId="inbox-empty"
            />
          ) : (
            visible.map((a) => (
              <AlertCard
                key={a.id}
                alert={a}
                onDismiss={() => dismissAtom(a.id)}
                onSnooze={() => snoozeAtom(a.id, Date.now() + 24 * 60 * 60_000)}
                onResolve={() => dismissAtom(a.id)}
                snoozeLabel={t("inbox.snooze24h")}
                resolveLabel={t("inbox.resolve")}
                dismissLabel={t("inbox.dismiss")}
                dueLabel={t("inbox.due")}
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
  snoozeLabel,
  resolveLabel,
  dismissLabel,
  dueLabel,
}: {
  alert: PendingAlert;
  onDismiss: () => void;
  onSnooze: () => void;
  onResolve: () => void;
  snoozeLabel: string;
  resolveLabel: string;
  dismissLabel: string;
  dueLabel: string;
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
              ? "text-[var(--ti-danger)]"
              : alert.severity === "warn"
                ? "text-[var(--ti-warn)]"
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
                · {dueLabel} {alert.due_at}
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
          aria-label={dismissLabel}
          title={dismissLabel}
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
          {snoozeLabel}
        </button>
        <button
          type="button"
          onClick={onResolve}
          className="rounded bg-[var(--ti-orange-500)] px-2 py-0.5 font-mono text-[11px] text-white hover:bg-[var(--ti-orange-600)]"
        >
          {resolveLabel}
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
// === end wave 5-α ===
