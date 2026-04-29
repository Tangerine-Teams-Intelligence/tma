/**
 * v1.16 Wave 4 D1 — Privacy section.
 *
 * Thin wrapper around the existing PrivacySettings panel. The R6 honest
 * panel (ASCII data-flow diagram + per-item ✓ list + telemetry toggle +
 * verify-local-execution audit) is preserved verbatim — Privacy was never
 * the bloated tab; the 9-tab cull just moves it from sibling-of-General
 * to one-of-three-top-level-sections.
 *
 * Why a wrapper instead of mounting PrivacySettings directly in
 * Settings.tsx? Two reasons:
 *   1. Symmetry with ConnectSection / SyncSection — Settings.tsx stays a
 *      pure dispatch shell over `section`-level components, no ad-hoc
 *      direct-mount asymmetries.
 *   2. Future-proofing — when someone wants to add a new privacy
 *      surface (e.g. a per-thread "what's been shared" view), it slots
 *      into this file rather than bloating Settings.tsx again.
 */

import { PrivacySettings } from "../PrivacySettings";

export function PrivacySection() {
  return (
    <div data-testid="st-section-privacy">
      <PrivacySettings />
    </div>
  );
}

export default PrivacySection;
