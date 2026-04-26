import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Mail,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  openExternal,
  emailTestConnection,
  emailFetchRecent,
  type EmailConfig,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";

type Provider = "gmail" | "outlook" | "imap";

const PROVIDER_DEFAULTS: Record<Provider, { host: string; port: number; helpUrl: string }> = {
  gmail: {
    host: "imap.gmail.com",
    port: 993,
    helpUrl: "https://myaccount.google.com/apppasswords",
  },
  outlook: {
    host: "outlook.office365.com",
    port: 993,
    helpUrl: "https://account.microsoft.com/security",
  },
  imap: { host: "", port: 993, helpUrl: "" },
};

/**
 * Email source setup — IMAP digest connector.
 *
 * The user picks a provider (Gmail / Outlook / custom IMAP), enters the
 * IMAP login (email address) and an *app password* (not their primary
 * password). We test the login server-side, then store the password in
 * the OS keychain. The daemon picks it up on the next heartbeat and
 * fetches recent threads daily.
 */
export default function EmailSourceRoute() {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.ui.pushToast);

  const [provider, setProvider] = useState<Provider>("gmail");
  const [username, setUsername] = useState("");
  const [appPassword, setAppPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [host, setHost] = useState(PROVIDER_DEFAULTS.gmail.host);
  const [port, setPort] = useState<number>(PROVIDER_DEFAULTS.gmail.port);
  const [lookbackDays, setLookbackDays] = useState<number>(7);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    error?: string | null;
  } | null>(null);

  const [fetching, setFetching] = useState(false);
  const [lastFetchSummary, setLastFetchSummary] = useState<string | null>(null);

  // Auto-fill host/port when provider switches.
  useEffect(() => {
    const d = PROVIDER_DEFAULTS[provider];
    setHost(d.host);
    setPort(d.port);
  }, [provider]);

  const usernameLooksOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username.trim());
  const passwordLooksOk = appPassword.trim().length >= 8;
  const canTest = usernameLooksOk && passwordLooksOk && host.trim().length > 0 && port > 0;

  function buildConfig(): EmailConfig {
    return {
      provider,
      username: username.trim(),
      app_password: appPassword,
      fetch_lookback_days: lookbackDays,
      host: host.trim(),
      port,
    };
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await emailTestConnection(buildConfig());
      setTestResult({ ok: r.ok, error: r.error });
      if (r.ok) {
        pushToast("success", "Email connection verified. Password saved to keychain.");
        // Wipe the in-memory password so it doesn't linger.
        setAppPassword("");
      } else {
        pushToast("error", `Connection failed: ${r.error ?? "unknown error"}`);
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setTestResult({ ok: false, error: msg });
      pushToast("error", `Connection failed: ${msg}`);
    } finally {
      setTesting(false);
    }
  }

  async function handleFetchNow() {
    setFetching(true);
    setLastFetchSummary(null);
    try {
      // The password is already in the keychain after a successful test —
      // we send the same config minus the password so the Rust side reads
      // it from TokenStore.
      const cfg = buildConfig();
      cfg.app_password = null;
      const r = await emailFetchRecent(cfg);
      setLastFetchSummary(
        `${r.messages_seen} messages, ${r.threads_written} thread${r.threads_written === 1 ? "" : "s"} written.`,
      );
      pushToast("success", `Fetched ${r.messages_seen} messages.`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      pushToast("error", `Fetch failed: ${msg}`);
    } finally {
      setFetching(false);
    }
  }

  return (
    <div className="min-h-full bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-50 px-6 dark:border-stone-800 dark:bg-stone-950">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          onClick={() => navigate("/memory")}
        >
          <ArrowLeft size={16} />
        </Button>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }}
        >
          <Mail size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Email
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Set up
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · Email</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Connect your inbox
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Tangerine reads recent threads via IMAP and writes one digest atom per thread to
          {" "}
          <code className="font-mono text-[12px]">~/.tangerine-memory/threads/email/</code>.
          Read-only — Tangerine never sends mail.
        </p>

        <Card className="mt-8">
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-2">
              <Label>Provider</Label>
              <div className="grid grid-cols-3 gap-2">
                {(["gmail", "outlook", "imap"] as Provider[]).map((p) => (
                  <button
                    type="button"
                    key={p}
                    onClick={() => setProvider(p)}
                    className={
                      "rounded-md border px-3 py-2 text-sm font-medium transition-colors " +
                      (provider === p
                        ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                        : "border-[var(--ti-border-default)] hover:bg-[var(--ti-paper-200)]")
                    }
                  >
                    {p === "imap" ? "Custom IMAP" : p[0].toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
              {provider !== "imap" && (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Server auto-filled to {PROVIDER_DEFAULTS[provider].host}:{PROVIDER_DEFAULTS[provider].port}.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="email-username">Email address</Label>
              <Input
                id="email-username"
                type="email"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="you@gmail.com"
                invalid={username.length > 0 && !usernameLooksOk}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email-password">App password</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="email-password"
                  type={showPassword ? "text" : "password"}
                  value={appPassword}
                  onChange={(e) => setAppPassword(e.target.value)}
                  placeholder="xxxxxxxxxxxxxxxx"
                  invalid={appPassword.length > 0 && !passwordLooksOk}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </Button>
              </div>
              <p className="text-xs text-stone-500 dark:text-stone-400">
                Use an <strong>app password</strong>, not your normal password.
                {provider === "gmail" && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                      onClick={() => openExternal(PROVIDER_DEFAULTS.gmail.helpUrl)}
                    >
                      Generate one for Gmail <ExternalLink size={10} className="inline" />
                    </button>
                  </>
                )}
                {provider === "outlook" && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                      onClick={() => openExternal(PROVIDER_DEFAULTS.outlook.helpUrl)}
                    >
                      Generate one for Outlook <ExternalLink size={10} className="inline" />
                    </button>
                  </>
                )}
              </p>
            </div>

            {provider === "imap" && (
              <div className="grid grid-cols-[2fr_1fr] gap-3">
                <div className="space-y-2">
                  <Label htmlFor="email-host">IMAP host</Label>
                  <Input
                    id="email-host"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="imap.example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email-port">Port</Label>
                  <Input
                    id="email-port"
                    type="number"
                    value={port}
                    onChange={(e) => setPort(parseInt(e.target.value, 10) || 0)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="email-lookback">Fetch lookback (days)</Label>
              <Input
                id="email-lookback"
                type="number"
                min={1}
                max={30}
                value={lookbackDays}
                onChange={(e) =>
                  setLookbackDays(
                    Math.max(1, Math.min(30, parseInt(e.target.value, 10) || 7)),
                  )
                }
              />
              <p className="text-xs text-stone-500 dark:text-stone-400">
                1–30. Daemon refetches every 24h.
              </p>
            </div>
          </CardContent>
        </Card>

        <div className="mt-6 flex items-center gap-2">
          <Button onClick={handleTest} disabled={!canTest || testing}>
            {testing ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Testing…
              </>
            ) : (
              "Test connection"
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleFetchNow}
            disabled={!testResult?.ok || fetching}
          >
            {fetching ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Fetching…
              </>
            ) : (
              <>
                <RefreshCw size={16} /> Fetch now
              </>
            )}
          </Button>
        </div>

        {testResult && (
          <p
            className={
              "mt-3 flex items-center gap-1 text-xs " +
              (testResult.ok ? "text-[#2D8659]" : "text-[#B83232]")
            }
          >
            {testResult.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
            {testResult.ok
              ? "Connection verified. App password saved to OS keychain."
              : `Failed: ${testResult.error ?? "unknown error"}`}
          </p>
        )}

        {lastFetchSummary && (
          <p className="mt-2 text-xs text-stone-700 dark:text-stone-300">
            Last fetch: {lastFetchSummary}
          </p>
        )}

        <section className="mt-10 rounded-md border border-stone-200 p-6 dark:border-stone-800">
          <p className="ti-section-label">What gets written</p>
          <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
            One markdown file per email thread. Frontmatter includes{" "}
            <code className="font-mono text-[12px]">subject</code>,{" "}
            <code className="font-mono text-[12px]">participants</code>,{" "}
            <code className="font-mono text-[12px]">last_message_at</code>, and{" "}
            <code className="font-mono text-[12px]">message_ids</code>. Body is the
            chronological digest.
          </p>
        </section>
      </main>
    </div>
  );
}
