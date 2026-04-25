/**
 * Supabase client singleton.
 *
 * Reads VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY at build time. When either is
 * missing we run in "stub" mode: no real client is created, and lib/auth.ts
 * fakes a successful session so dev work can proceed without a Supabase project.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isStubMode = !url || !anonKey;

if (isStubMode) {
  // eslint-disable-next-line no-console
  console.warn(
    "[supabase] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY missing — running in STUB mode. Auth screens will fake successful login. Set both env vars in app/.env to enable real auth.",
  );
}

export const supabase: SupabaseClient | null = isStubMode
  ? null
  : createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: typeof window !== "undefined" ? window.localStorage : undefined,
      },
    });
