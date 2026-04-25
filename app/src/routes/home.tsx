import { Link } from "react-router-dom";

/**
 * Placeholder home page. T2 owns the real Meetings list (ML-0).
 */
export default function HomeRoute() {
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
        <Link
          to="/skills/meeting"
          className="mt-4 inline-block text-xs text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
        >
          Configure Meeting skill
        </Link>
      </div>
    </div>
  );
}
