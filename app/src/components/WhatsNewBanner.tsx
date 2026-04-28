import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { X, Pin } from "lucide-react";
import { readWhatsNew, markUserOpened } from "@/lib/views";
import { useStore } from "@/lib/store";

/**
 * Yellow startup banner that appears across the top of the AppShell when:
 *
 *   1. The user's cursor.last_opened_at is older than 1 hour, AND
 *   2. There are unviewed atoms newer than that timestamp.
 *
 * On mount we read read_whats_new (which compares cursor → timeline). If
 * count > 0 and the banner hasn't been dismissed this session, we show it.
 *
 * Click "Show me" → navigates to /today and the banner closes.
 * Click ✕ → banner dismissed for this session (ui.whatsNewDismissed = true)
 *           AND we bump cursor.last_opened_at so next session compares
 *           against now, not the stale value.
 */
export function WhatsNewBanner() {
  const navigate = useNavigate();
  const currentUser = useStore((s) => s.ui.currentUser);
  const dismissed = useStore((s) => s.ui.whatsNewDismissed);
  const setDismissed = useStore((s) => s.ui.setWhatsNewDismissed);
  const [count, setCount] = useState(0);
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    let cancel = false;
    // === v1.13.8 round-8 === — readWhatsNew now re-throws on Tauri-side
    // failure (was masking into mock zero-count). The banner is non-
    // critical: if the cursor diff fails, hide the banner rather than
    // breaking AppShell render. The console.error inside the wrapper
    // still surfaces the failure for debugging.
    readWhatsNew(currentUser)
      .then((d) => {
        if (cancel) return;
        // Only fire when last_opened_at is older than 1 hour AND we have
        // newer atoms. The "since" string is the cursor's last_opened_at;
        // missing means "never opened" — show the banner once on first run.
        const sinceMs = d.since ? Date.parse(d.since) : 0;
        const oldEnough = !d.since || Date.now() - sinceMs > 60 * 60 * 1000;
        const has = d.count > 0;
        setCount(d.count);
        setShouldShow(has && oldEnough);
      })
      .catch(() => {
        if (!cancel) {
          setCount(0);
          setShouldShow(false);
        }
      });
    return () => {
      cancel = true;
    };
  }, [currentUser]);

  if (dismissed || !shouldShow || count === 0) return null;

  const onShowMe = () => {
    setDismissed(true);
    void markUserOpened(currentUser);
    navigate("/today");
  };
  const onDismiss = () => {
    setDismissed(true);
    void markUserOpened(currentUser);
  };

  return (
    <div
      data-whats-new-banner
      role="status"
      className="ti-no-select flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-2 text-[12px] text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <Pin size={12} className="shrink-0 rotate-45" aria-hidden />
      <span className="flex-1">
        <strong className="font-semibold">{count}</strong> new{" "}
        {count === 1 ? "atom" : "atoms"} since you last looked.
      </span>
      <button
        type="button"
        onClick={onShowMe}
        className="rounded border border-amber-400 bg-amber-100 px-2 py-0.5 font-mono text-[11px] hover:bg-amber-200 dark:border-amber-600 dark:bg-amber-900 dark:hover:bg-amber-800"
      >
        Show me
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
      >
        <X size={12} />
      </button>
    </div>
  );
}
