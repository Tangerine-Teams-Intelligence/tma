import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { signIn, signUp } from "@/lib/auth";
import { isStubMode } from "@/lib/supabase";

type Mode = "signin" | "signup";

export default function AuthRoute() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

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
      navigate("/dashboard", { replace: true });
    } finally {
      setBusy(false);
    }
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
          {mode === "signin" ? "Sign in" : "Create your account"}
        </h1>
        <p className="mt-2 text-sm text-[var(--ti-ink-700)]">
          {mode === "signin"
            ? "Welcome back."
            : "One account per operator. Skills are added inside the app."}
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

        <form onSubmit={submit} className="mt-8 space-y-4">
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
            <p className="flex items-center gap-1 text-xs text-[#B83232]">
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
