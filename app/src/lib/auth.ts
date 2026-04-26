/**
 * Auth helpers. Wraps Supabase but transparently no-ops in stub mode so dev can
 * proceed without a real Supabase project.
 */

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, isStubMode } from "./supabase";

const STUB_SESSION_KEY = "tangerine.auth.stubSession";

interface StubSession {
  email: string;
  signedInAt: number;
}

function readStubSession(): StubSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STUB_SESSION_KEY);
    return raw ? (JSON.parse(raw) as StubSession) : null;
  } catch {
    return null;
  }
}

function writeStubSession(s: StubSession | null) {
  if (typeof window === "undefined") return;
  if (s) window.localStorage.setItem(STUB_SESSION_KEY, JSON.stringify(s));
  else window.localStorage.removeItem(STUB_SESSION_KEY);
}

export interface AuthState {
  loading: boolean;
  signedIn: boolean;
  email: string | null;
}

export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({
    loading: true,
    signedIn: false,
    email: null,
  });

  useEffect(() => {
    let cancel = false;

    if (isStubMode || !supabase) {
      const stub = readStubSession();
      setState({ loading: false, signedIn: !!stub, email: stub?.email ?? null });
      // Listen for cross-tab stub changes.
      const onStorage = (e: StorageEvent) => {
        if (e.key !== STUB_SESSION_KEY) return;
        const next = readStubSession();
        setState({ loading: false, signedIn: !!next, email: next?.email ?? null });
      };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }

    void supabase.auth.getSession().then(({ data }) => {
      if (cancel) return;
      const s = data.session;
      setState({
        loading: false,
        signedIn: !!s,
        email: s?.user?.email ?? null,
      });
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, session: Session | null) => {
      setState({
        loading: false,
        signedIn: !!session,
        email: session?.user?.email ?? null,
      });
    });

    return () => {
      cancel = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return state;
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  if (isStubMode || !supabase) {
    if (!email.includes("@")) return { ok: false, error: "Enter a valid email." };
    if (password.length < 6) return { ok: false, error: "Password too short (stub: ≥6 chars)." };
    writeStubSession({ email, signedInAt: Date.now() });
    // Synthetic event so useAuth subscribers in same tab also update.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STUB_SESSION_KEY, newValue: "stub" }),
      );
    }
    return { ok: true };
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signUp(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string }> {
  if (isStubMode || !supabase) {
    if (!email.includes("@")) return { ok: false, error: "Enter a valid email." };
    if (password.length < 6) return { ok: false, error: "Password too short (stub: ≥6 chars)." };
    writeStubSession({ email, signedInAt: Date.now() });
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STUB_SESSION_KEY, newValue: "stub" }),
      );
    }
    return { ok: true };
  }
  const { error } = await supabase.auth.signUp({ email, password });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signOut(): Promise<void> {
  if (isStubMode || !supabase) {
    writeStubSession(null);
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new StorageEvent("storage", { key: STUB_SESSION_KEY, newValue: null }),
      );
    }
    return;
  }
  await supabase.auth.signOut();
}
