// === wave 5-γ ===
/**
 * Shared Playwright init seed for the legacy `/e2e/` suite.
 *
 * The smoke suite at `playwright-tests/smoke.spec.ts` discovered (during
 * v3.5 wave 1) that the auth gate redirects unauthenticated visits to
 * `/auth`, so seeding only `__TMI_MOCK__` is insufficient — every legacy
 * spec lands on the login screen and fails its first assertion.
 *
 * This helper centralizes the auth + zustand seed so each spec only has
 * to call `seedStubSession(page)` in its `beforeEach`.
 *
 * Keep keys in sync with:
 *   - `app/src/lib/auth.ts::STUB_SESSION_KEY`
 *   - `app/src/lib/store.ts` zustand persist key (`tangerine.skills`)
 */
import type { Page } from "@playwright/test";

export async function seedStubSession(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // (1) Auth gate bypass — actual key per lib/auth.ts.
    try {
      window.localStorage.setItem(
        "tangerine.auth.stubSession",
        JSON.stringify({
          email: "e2e@tangerine.test",
          signedInAt: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }

    // (2) Zustand persist seed — keeps protected routes from redirecting
    // to /onboarding-team AND dismisses the Wave 4-C welcome overlay so it
    // doesn't intercept clicks. Shape mirrors `partialize` in lib/store.ts.
    try {
      const persisted = {
        state: {
          ui: {
            memoryConfig: {
              mode: "solo",
              personalDirEnabled: true,
            },
            currentUser: "e2e",
            samplesSeeded: true,
            sampleBannerDismissed: true,
            // Wave 4-C welcome overlay latch — without this the modal
            // mounts on every fresh launch and intercepts pointer events.
            welcomed: true,
            newcomerOnboardingShown: true,
          },
          skills: { meetingConfig: {} },
        },
        version: 0,
      };
      window.localStorage.setItem(
        "tangerine.skills",
        JSON.stringify(persisted),
      );
    } catch {
      /* ignore */
    }

    // (3) Tauri command mock seed used by the legacy /e2e/ suite.
    (window as unknown as { __TMI_MOCK__: unknown }).__TMI_MOCK__ = {
      config: { schema_version: 1 },
    };
  });
}
