import { useStore } from "@/lib/store";

/**
 * Placeholder home page. T2 owns the real Meetings list (ML-0).
 */
export default function HomeRoute() {
  const pushToast = useStore((s) => s.ui.pushToast);
  const wizardReset = useStore((s) => s.wizard.reset);
  const setStep = useStore((s) => s.wizard.setStep);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="font-display text-3xl tracking-tight text-[var(--ti-ink-900)]">
        Meetings
      </h1>
      <p className="mt-2 text-sm text-[var(--ti-ink-500)]">
        T2 will replace this placeholder with the meetings list (ML-0).
      </p>

      <div className="mt-8 rounded-lg border border-dashed border-[var(--ti-border-default)] p-12 text-center">
        <p className="text-sm text-[var(--ti-ink-700)]">No meetings yet.</p>
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">T2 will add the New Meeting flow here.</p>
        <button
          className="mt-4 text-xs text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
          onClick={() => {
            wizardReset();
            setStep(0);
            pushToast("info", "Re-running setup wizard…");
          }}
        >
          Re-run setup wizard
        </button>
      </div>
    </div>
  );
}
