import * as React from "react";
import { Progress } from "@/components/ui/progress";
import { useStore } from "@/lib/store";

interface Props {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** "1 / 5 — Step name" — locked format per APP-INTERFACES.md §3 */
  stepLabel?: string;
  footer: React.ReactNode;
}

const TOTAL_STEPS = 5;

export function WizardShell({ title, subtitle, children, stepLabel, footer }: Props) {
  const step = useStore((s) => s.wizard.step);
  const pct = Math.round((step / TOTAL_STEPS) * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-[var(--ti-paper-100)] animate-fade-in">
      <div className="flex w-full max-w-3xl flex-col p-8">
        {step > 0 && (
          <div className="mb-8 space-y-2">
            <div className="flex items-center justify-between">
              <span className="ti-section-label">{stepLabel ?? `Step ${step} of ${TOTAL_STEPS}`}</span>
              <span className="text-xs text-[var(--ti-ink-500)]">
                {step} / {TOTAL_STEPS}
              </span>
            </div>
            <Progress value={pct} />
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <h1 className="font-display text-3xl tracking-tight text-[var(--ti-ink-900)]">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-2 text-base text-[var(--ti-ink-700)]">{subtitle}</p>
          )}
          <div className="mt-8">{children}</div>
        </div>

        <div className="mt-8 flex items-center justify-between gap-3 border-t border-[var(--ti-border-faint)] pt-6">
          {footer}
        </div>
      </div>
    </div>
  );
}
