import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, AlertCircle, Github } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { signIn, signUp } from "@/lib/auth";
import { isStubMode } from "@/lib/supabase";
import { useStore } from "@/lib/store";
// === v2.5 real auth ===
// v2.5 §3 — real Supabase auth surface. Existing v1.x stub-mode auth is
// preserved (default) so dev work proceeds without keys; "Sign in with real
// account" reveals the real-auth UI (email/password + OAuth) backed by the
// `auth_*` Tauri commands. The Tauri command surface itself stays in stub
// mode until `SUPABASE_URL` + `SUPABASE_ANON_KEY` env vars are set.
import {
  authSignInEmailPassword,
  authSignUp,
  authSignInOauth,
} from "@/lib/tauri";
// === end v2.5 real auth ===

type Mode = "signin" | "signup";

export default function AuthRoute() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const setLocalOnly = useStore((s) => s.ui.setLocalOnly);
  // === v2.5 real auth ===
  // Hidden behind a button so existing v1.x users land on the same
  // 6-char-stub UI by default. Once they click "Sign in with real account"
  // we reveal the real-auth panel.
  const [showRealAuth, setShowRealAuth] = useState(false);
  const setAuthMode = useStore((s) => s.ui.setAuthMode);

  async function submitReal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const fn = mode === "signin" ? authSignInEmailPassword : authSignUp;
      const session = await fn(email.trim(), password);
      setAuthMode(session.mode);
      // Mirror to lib/auth.ts stub session so existing route-guard hooks
      // continue to read a non-empty session without re-plumbing.
      await signIn(email.trim(), password);
      setLocalOnly(false);
      navigate("/today", { replace: true });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function oauth(provider: "github" | "google") {
    setError(null);
    setBusy(true);
    try {
      const session = await authSignInOauth(provider);
      setAuthMode(session.mode);
      await signIn(session.email, "oauth-stub-pwd");
      setLocalOnly(false);
      navigate("/today", { replace: true });
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }
  // === end v2.5 real auth ===

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const fn = mode === "signin" ? signIn : signUp;
      const r = await fn(email.trim(), password);
      if (!r.ok) {
        setError(r.error ?? "Something went wrong.");
        return;
      }
      setLocalOnly(false);
      navigate("/today", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  function skipToLocal() {
    setLocalOnly(true);
    // Stub-mode auth lets us drop a local synthetic session so the route
    // guard in App.tsx lets us through. Email is just a label.
    void signIn("local@tangerine.local", "localmode").then(() => {
      navigate("/today", { replace: true });
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-[var(--ti-paper-100)] animate-fade-in">
      <div className="flex w-full max-w-md flex-col justify-center p-8">
        <div className="mb-10 flex items-center gap-3">
          <div
            className="h-9 w-9 rounded-lg"
            style={{ background: "var(--ti-orange-500)" }}
            aria-hidden
          />
          <span className="font-display text-2xl tracking-tight text-[var(--ti-ink-900)]">
            Tangerine AI Teams
          </span>
        </div>

        <h1 className="font-display text-3xl tracking-tight text-[var(--ti-ink-900)]">
          Align every AI tool on your team with your team's actual workflow.
        </h1>
        <p className="mt-2 text-sm text-[var(--ti-ink-700)]">
          Your team uses Cursor, Claude, ChatGPT — but each AI sees a different
          slice of what your team's actually doing. We align them all with one
          source of team workflow, so your AIs stop giving different
          answers.
        </p>

        {isStubMode && (
          <Card className="mt-4 border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-50)]">
            <CardContent className="pt-4 text-xs text-[var(--ti-ink-700)]">
              <span className="font-medium text-[var(--ti-orange-700)]">Stub mode.</span>{" "}
              No Supabase project is configured. Any email + 6+ char password will sign
              you in locally.
            </CardContent>
          </Card>
        )}

        <form
          onSubmit={showRealAuth ? submitReal : submit}
          className="mt-8 space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@team.com"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={6}
            />
          </div>

          {error && (
            <p className="flex items-center gap-1 text-xs text-[var(--ti-danger)]">
              <AlertCircle size={12} /> {error}
            </p>
          )}

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? (
              <>
                <Loader2 size={16} className="animate-spin" />{" "}
                {mode === "signin" ? "Signing in…" : "Creating account…"}
              </>
            ) : mode === "signin" ? (
              "Sign in"
            ) : (
              "Create account"
            )}
          </Button>

          <Button
            type="button"
            variant="outline"
            disabled={busy}
            className="w-full"
            onClick={skipToLocal}
          >
            Skip — local only mode
          </Button>
          <p className="text-center text-[11px] text-[var(--ti-ink-500)]">
            Memory dir lives on this machine. Nothing leaves until you wire a Sink.
          </p>

          {/* === v2.5 real auth === */}
          <div className="border-t border-[var(--ti-ink-200,#E5E5E0)] pt-4">
            {!showRealAuth ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                className="w-full"
                onClick={() => {
                  setShowRealAuth(true);
                  setError(null);
                }}
              >
                Sign in with real account
              </Button>
            ) : (
              <>
                <p className="mb-2 text-center text-[11px] text-[var(--ti-ink-500)]">
                  Real auth (Supabase). Stub-mode acceptable until CEO unblocks
                  keys.
                </p>
                <div className="flex flex-col gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void oauth("github")}
                    className="w-full"
                  >
                    <Github size={14} /> Continue with GitHub
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void oauth("google")}
                    className="w-full"
                  >
                    Continue with Google
                  </Button>
                </div>
                <button
                  type="button"
                  className="mt-2 w-full text-center text-[11px] text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                  onClick={() => {
                    setShowRealAuth(false);
                    setError(null);
                  }}
                >
                  Back to stub auth
                </button>
              </>
            )}
          </div>
          {/* === end v2.5 real auth === */}
        </form>

        <div className="mt-6 text-center text-xs text-[var(--ti-ink-500)]">
          {mode === "signin" ? (
            <>
              No account yet?{" "}
              <button
                type="button"
                className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                onClick={() => {
                  setMode("signup");
                  setError(null);
                }}
              >
                Create one
              </button>
            </>
          ) : (
            <>
              Already have one?{" "}
              <button
                type="button"
                className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                onClick={() => {
                  setMode("signin");
                  setError(null);
                }}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
