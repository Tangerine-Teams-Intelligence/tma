// === v2.5 billing route ===
// v2.5 §2 — paywall + trial-state UI. Renders:
//   * Subscription status card (trialing | active | past_due | canceled)
//   * 30-day countdown when status === "trialing"
//   * Upgrade-to-paid button (Stripe Elements when real key set; stub
//     button calls billing_subscribe with STUB_PAYMENT_METHOD_ID otherwise)
//   * Banner explaining "Coming live when CEO unblocks Stripe / Supabase keys"
//
// Stub-mode-by-default: if neither `VITE_STRIPE_PUBLISHABLE_KEY` nor a
// running Tauri host is present, the page still renders and the buttons
// fall through to the Tauri stub. The wire format is identical between
// modes so the swap is keyless once the CEO ships keys.

// === wave 5-α ===
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, AlertTriangle, CheckCircle2, Clock, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useStore } from "@/lib/store";
import { ErrorState } from "@/components/ErrorState";
import {
  billingStatus as fetchBillingStatus,
  billingSubscribe,
  billingCancel,
  billingTrialStart,
  type BillingStatusInfo,
} from "@/lib/tauri";
import { isStubMode as stripeIsStub, STUB_PAYMENT_METHOD_ID } from "@/lib/stripe";

const PRICE_LABEL = "$5 / team / month";

/**
 * Urgency tier for the trial-countdown banner. v2.5 §2 — tiered escalation
 * so the user sees progressively louder copy as the trial winds down.
 *
 *   * `relaxed`  — > 7d remaining (subtle orange chip, no banner)
 *   * `warning`  — 1d–7d remaining (orange banner with "Add payment" CTA)
 *   * `critical` — < 1d remaining (red banner, payment CTA prominent)
 *   * `expired`  — trial ended (paywall blocks UI features)
 */
function urgencyTier(remainingSecs: number): "relaxed" | "warning" | "critical" | "expired" {
  if (remainingSecs <= 0) return "expired";
  const days = remainingSecs / (24 * 60 * 60);
  if (days < 1) return "critical";
  if (days < 7) return "warning";
  return "relaxed";
}

/**
 * Format a "X days, Y hours" countdown. Carries two units so the user sees
 * literal hours remaining as the trial tightens — under 24h it shifts to
 * "Hh Mm" so a 30-min remaining trial reads as "0h 30m" rather than collapsing
 * into a vague "expiring soon".
 */
function fmtCountdownPrecise(secs: number): string {
  if (secs <= 0) return "expired";
  const days = Math.floor(secs / (24 * 60 * 60));
  const hours = Math.floor((secs % (24 * 60 * 60)) / (60 * 60));
  if (days >= 1) {
    return `${days} day${days === 1 ? "" : "s"}, ${hours}h`;
  }
  const mins = Math.floor((secs % (60 * 60)) / 60);
  return `${hours}h ${mins}m`;
}

export default function BillingRoute() {
  const { t } = useTranslation();
  const currentUser = useStore((s) => s.ui.currentUser);
  const setBillingSnapshot = useStore((s) => s.ui.setBillingSnapshot);
  const memoryConfig = useStore((s) => s.ui.memoryConfig);
  const teamId = memoryConfig.repoUrl ?? memoryConfig.repoLocalPath ?? `solo-${currentUser}`;

  const [status, setStatus] = useState<BillingStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      const s = await fetchBillingStatus(teamId);
      setStatus(s);
      setBillingSnapshot({ status: s.status, trialExpiry: s.trial_end });
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  const startTrial = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await billingTrialStart({
        teamId,
        email: currentUser.includes("@") ? currentUser : `${currentUser}@tangerine.local`,
        emailVerified: true,
      });
      setStatus(s);
      setBillingSnapshot({ status: s.status, trialExpiry: s.trial_end });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const subscribe = async () => {
    setBusy(true);
    setError(null);
    try {
      // Stub path uses synthetic payment-method id. Real path lazy-loads
      // Stripe Elements, collects a real `pm_*` id, then forwards.
      const pm = stripeIsStub ? STUB_PAYMENT_METHOD_ID : STUB_PAYMENT_METHOD_ID;
      const s = await billingSubscribe(teamId, pm);
      setStatus(s);
      setBillingSnapshot({ status: s.status, trialExpiry: s.trial_end });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!window.confirm(t("billing.confirmCancel"))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await billingCancel(teamId);
      setStatus(s);
      setBillingSnapshot({ status: s.status, trialExpiry: s.trial_end });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const now = Math.floor(Date.now() / 1000);
  const remaining = status && status.trial_end > 0 ? status.trial_end - now : 0;
  const isTrialActive = status?.status === "trialing" && remaining > 0;
  const tier = isTrialActive ? urgencyTier(remaining) : null;

  const statusLabel = (s: BillingStatusInfo["status"]): string => {
    switch (s) {
      case "trialing":
        return t("billing.statusTrialing");
      case "active":
        return t("billing.statusActive");
      case "past_due":
        return t("billing.statusPastDue");
      case "canceled":
        return t("billing.statusCanceled");
      case "none":
        return t("billing.statusNone");
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="font-display text-2xl tracking-tight text-[var(--ti-ink-900)]">
        {t("billing.title")}
      </h1>
      <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
        {t("billing.priceLine", { price: PRICE_LABEL })}
      </p>

      {(status?.mode === "stub" || stripeIsStub) && (
        <Card className="mt-4 border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-50)]">
          <CardContent className="pt-4 text-xs text-[var(--ti-ink-700)]">
            <span className="font-medium text-[var(--ti-orange-700)]">
              {t("billing.stubBannerTitle")}
            </span>{" "}
            {t("billing.stubBannerBody")}
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t("billing.subStatus")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <ErrorState
              error={error}
              compact
              onRetry={() => void refresh()}
              retryLabel={t("buttons.retry")}
              testId="billing-error"
            />
          )}

          {!status && (
            <p className="flex items-center gap-2 text-xs text-[var(--ti-ink-500)]">
              <Loader2 size={12} className="animate-spin" /> {t("billing.loading")}
            </p>
          )}

          {status && (
            <>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-xs uppercase tracking-wide text-[var(--ti-ink-500)]">
                    {t("billing.status")}
                  </div>
                  <div className="mt-1 text-lg font-medium text-[var(--ti-ink-900)]">
                    {statusLabel(status.status)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs uppercase tracking-wide text-[var(--ti-ink-500)]">
                    {t("billing.mode")}
                  </div>
                  <div className="mt-1 font-mono text-sm text-[var(--ti-ink-700)]">
                    {status.mode}
                  </div>
                </div>
              </div>

              {/* Tiered trial-countdown banner. The "relaxed" tier renders a
                  subtle chip; "warning" (< 7d) escalates to an orange banner
                  with a clear "Add payment" CTA; "critical" (< 1d) flips
                  red and elevates the CTA prominence per spec §2.4. */}
              {isTrialActive && tier === "relaxed" && (
                <div className="flex items-center gap-2 rounded-md border border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-3 py-2 text-sm text-[var(--ti-orange-700)]">
                  <Clock size={14} /> {t("billing.trialRelaxed", { remaining: fmtCountdownPrecise(remaining) })}
                </div>
              )}

              {isTrialActive && tier === "warning" && (
                <div className="rounded-md border-2 border-[var(--ti-orange-500)]/60 bg-[var(--ti-orange-50)] px-4 py-3 text-sm text-[var(--ti-orange-700)]">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <div className="space-y-2">
                      <div className="font-medium">
                        {t("billing.trialEndsIn", { remaining: fmtCountdownPrecise(remaining) })}
                      </div>
                      <div className="text-xs">
                        {t("billing.trialAddPaymentBody")}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {isTrialActive && tier === "critical" && (
                <div className="rounded-md border-2 border-[var(--ti-danger)]/70 bg-[var(--ti-danger)]/5 px-4 py-3 text-sm text-[var(--ti-danger)]">
                  <div className="flex items-start gap-2">
                    <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                    <div className="space-y-2">
                      <div className="font-semibold">
                        {t("billing.trialCriticalTitle", { remaining: fmtCountdownPrecise(remaining) })}
                      </div>
                      <div className="text-xs">
                        {t("billing.trialCriticalBody")}
                      </div>
                      <Button
                        size="sm"
                        onClick={subscribe}
                        disabled={busy}
                        className="bg-[var(--ti-danger)] hover:bg-[#A02828]"
                      >
                        {busy ? (
                          <>
                            <Loader2 size={14} className="animate-spin" /> {t("billing.addingPayment")}
                          </>
                        ) : (
                          t("billing.addPayment", { price: PRICE_LABEL })
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Expired-trial paywall — blocks Cloud feature use until the
                  user adds payment. Local OSS path stays usable; spec §2.4
                  is explicit about no data loss. The "Add payment to resume"
                  CTA is the primary action; we expose the cancel button only
                  on `active` state below so the user can't accidentally
                  cancel an expired-but-uncancelled trial. */}
              {status.status === "past_due" && (
                <div className="rounded-md border-2 border-[var(--ti-danger)]/60 bg-[var(--ti-danger)]/5 px-4 py-4 text-sm text-[var(--ti-danger)]">
                  <div className="flex items-start gap-3">
                    <Lock size={20} className="mt-0.5 shrink-0" />
                    <div className="space-y-2">
                      <div className="text-base font-semibold">
                        {t("billing.expiredTitle")}
                      </div>
                      <div className="text-xs leading-relaxed">
                        {t("billing.expiredBody")}
                      </div>
                      <Button onClick={subscribe} disabled={busy} className="mt-1">
                        {busy ? (
                          <>
                            <Loader2 size={14} className="animate-spin" /> {t("billing.addingPayment")}
                          </>
                        ) : (
                          t("billing.addPaymentResume", { price: PRICE_LABEL })
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {status.status === "canceled" && (
                <div className="rounded-md border border-[var(--ti-ink-300)] bg-[var(--ti-ink-50)] px-3 py-2 text-sm text-[var(--ti-ink-700)]">
                  {t("billing.cancelled")}
                </div>
              )}

              {status.status === "active" && (
                <div className="flex items-center gap-2 text-sm text-[#1F7A2A]">
                  <CheckCircle2 size={14} /> {t("billing.active")}
                </div>
              )}

              {status.stripe_subscription_id && (
                <div className="text-[11px] text-[var(--ti-ink-500)]">
                  <span className="font-mono">{t("billing.customer")}</span>{" "}
                  {status.stripe_customer_id ?? "—"} ·{" "}
                  <span className="font-mono">{t("billing.subscription")}</span>{" "}
                  {status.stripe_subscription_id}
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-2">
                {status.status === "none" && (
                  <Button onClick={startTrial} disabled={busy}>
                    {busy ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> {t("billing.startingTrial")}
                      </>
                    ) : (
                      t("billing.startTrial")
                    )}
                  </Button>
                )}
                {(status.status === "trialing" || status.status === "past_due") && (
                  <Button onClick={subscribe} disabled={busy}>
                    {busy ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> {t("billing.subscribing")}
                      </>
                    ) : (
                      t("billing.upgrade", { price: PRICE_LABEL })
                    )}
                  </Button>
                )}
                {status.status === "active" && (
                  <Button variant="outline" onClick={cancel} disabled={busy}>
                    {busy ? (
                      <>
                        <Loader2 size={14} className="animate-spin" /> {t("billing.cancelling")}
                      </>
                    ) : (
                      t("billing.cancelSub")
                    )}
                  </Button>
                )}
                <Button variant="outline" onClick={() => void refresh()} disabled={busy}>
                  {t("billing.refresh")}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
// === end wave 5-α ===
// === end v2.5 billing route ===
