// === v1.15.0 Wave 1.4 ===
/**
 * v1.15.0 Wave 1.4 — Solo Cloud upgrade prompt container.
 *
 * Owns the IPC round-trip to `listAtoms` so the presentational
 * `SoloCloudUpgradePrompt` stays prop-driven (and unit-testable).
 *
 * Refresh policy:
 *   - Initial: hydrate atom count once on mount.
 *   - Live: re-count whenever the wave-16 `activity:atom_written` event
 *     fires — every real capture nudges the count by +1 so the
 *     50-atom trigger is reactive.
 *   - Eligibility re-check ticks every minute so the 7-day clock can
 *     trip even when no new atom landed.
 *
 * Defensive: every IPC failure degrades to "0 atoms" so a broken
 * `list_atoms` can't blank the shell or wedge the banner.
 */

import { useEffect, useState } from "react";

import { listAtoms } from "@/lib/atoms";
import { listenActivityAtoms } from "@/lib/tauri";
import { SoloCloudUpgradePrompt } from "@/components/SoloCloudUpgradePrompt";

export function SoloCloudUpgradePromptContainer() {
  const [atomCount, setAtomCount] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const refresh = async () => {
      try {
        const r = await listAtoms({});
        if (cancelled) return;
        setAtomCount(r.atoms.length);
      } catch {
        // IPC failed — keep the previous count rather than zeroing
        // out the eligibility check. Defensive against a transient
        // Rust-side error.
      }
    };

    void refresh();

    void (async () => {
      const off = await listenActivityAtoms(() => {
        // Each capture bumps the count by 1. We do NOT re-list on every
        // event because that would flood the IPC bridge for a busy
        // ingest run; +1 stays correct as long as the listener is alive.
        setAtomCount((c) => c + 1);
      });
      if (cancelled) {
        try {
          off();
        } catch {
          // ignore
        }
        return;
      }
      unlisten = off;
    })();

    // Tick the clock once a minute so the 7-day branch trips even
    // when no fresh atom lands. 60s cadence is fine — the threshold
    // is days, not seconds.
    const timer = setInterval(() => setNow(Date.now()), 60_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return <SoloCloudUpgradePrompt atomCount={atomCount} now={now} />;
}
// === end v1.15.0 Wave 1.4 ===
