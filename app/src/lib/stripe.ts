/**
 * Stripe Elements wrapper.
 *
 * Reads `VITE_STRIPE_PUBLISHABLE_KEY` at build time. When missing we run in
 * "stub" mode: no Stripe SDK is loaded, the `/billing` route renders a
 * placeholder card UI, and `subscribeWithCard()` calls back to the Tauri
 * `billing_subscribe` command in stub mode (which simulates the
 * `customer.subscription.created` webhook server-side).
 *
 * v2.5.0-alpha.1 wires the real `@stripe/stripe-js` lazy-load behind a
 * dynamic import so the stub-mode bundle stays light. Until the CEO
 * unblocks the publishable key + the Stripe Connect account is provisioned,
 * the lazy-load path is gated by `isStubMode === false` so the production
 * bundle never tries to fetch `js.stripe.com` during stub-mode dev.
 *
 * Wire shape locked per V2_5_SPEC.md §2.
 */

const publishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined;

export const isStubMode = !publishableKey;

if (isStubMode) {
  // eslint-disable-next-line no-console
  console.warn(
    "[stripe] VITE_STRIPE_PUBLISHABLE_KEY missing — running in STUB mode. Billing UI renders a placeholder; subscribe falls through to billing_subscribe stub.",
  );
}

/**
 * Lazy load `@stripe/stripe-js` so the stub-mode bundle stays light. Returns
 * `null` in stub mode — callers handle that path themselves and fall back to
 * the Tauri stub.
 */
let stripeClientCache: unknown | null = null;

export async function loadStripeClient(): Promise<unknown | null> {
  if (isStubMode) return null;
  if (stripeClientCache) return stripeClientCache;
  try {
    // Dynamic import keeps the dep optional — projects in stub mode do not
    // need `@stripe/stripe-js` installed for the bundle to build. We use a
    // `Function`-style import so TypeScript doesn't try to resolve the
    // module at type-check time (it's not in `package.json` until the CEO
    // unblocks Stripe and a sibling agent adds the dep).
    const dynImport = new Function("p", "return import(p)") as (
      p: string,
    ) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await dynImport("@stripe/stripe-js")) as any;
    if (typeof mod?.loadStripe !== "function") return null;
    stripeClientCache = await mod.loadStripe(publishableKey!);
    return stripeClientCache;
  } catch (e) {
    // Module not installed — silent stub fallback.
    // eslint-disable-next-line no-console
    console.warn("[stripe] @stripe/stripe-js failed to load:", e);
    return null;
  }
}

/**
 * Synthetic payment-method id used when stub mode short-circuits the
 * Elements flow. The Rust side writes this through to `cus_stub_*` /
 * `sub_stub_*` ids so the React surface can display them.
 */
export const STUB_PAYMENT_METHOD_ID = "pm_stub_card_visa";

export interface StripeMode {
  isStub: boolean;
  publishableKey: string | null;
}

export function stripeModeInfo(): StripeMode {
  return { isStub: isStubMode, publishableKey: publishableKey ?? null };
}
