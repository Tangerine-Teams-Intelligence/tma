import { useEffect, useRef, useState } from "react";
import { ExternalLink, Eye, EyeOff, Copy, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { WizardShell } from "./WizardShell";
import { useStore } from "@/lib/store";
import {
  buildInviteUrl,
  extractClientId,
  isPlausibleBotToken,
  DISCORD_POLL_INTERVAL_MS,
  DISCORD_POLL_HINT_AFTER_MS,
} from "@/lib/discord";
import { openExternal, pollDiscordBotPresence } from "@/lib/tauri";
import { cn } from "@/lib/utils";

type SubStep = 1 | 2 | 3;

export function SW1DiscordBot() {
  const back = useStore((s) => s.wizard.back);
  const next = useStore((s) => s.wizard.next);
  const setField = useStore((s) => s.wizard.setField);
  const collected = useStore((s) => s.wizard.collected);

  const [sub, setSub] = useState<SubStep>(1);
  const [openedPortal, setOpenedPortal] = useState(false);
  const [token, setToken] = useState(collected.discordToken ?? "");
  const [showToken, setShowToken] = useState(false);
  const tokenValid = isPlausibleBotToken(token);
  const tokenTouched = token.length > 0;

  // SW-1.3 polling state
  const [polling, setPolling] = useState(false);
  const [pollDuration, setPollDuration] = useState(0);
  const [guilds, setGuilds] = useState<{ id: string; name: string }[]>([]);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(
    collected.guildId ?? null
  );
  const [copied, setCopied] = useState(false);

  const pollTimer = useRef<number | null>(null);
  const durationTimer = useRef<number | null>(null);

  const clientId = extractClientId(token);
  const inviteUrl = clientId ? buildInviteUrl(clientId) : null;

  // ---- SW-1.3 polling lifecycle ----
  useEffect(() => {
    if (sub !== 3 || !tokenValid) {
      stopPolling();
      return;
    }
    startPolling();
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub, tokenValid]);

  function startPolling() {
    setPolling(true);
    setPollDuration(0);
    setGuilds([]);

    durationTimer.current = window.setInterval(() => {
      setPollDuration((d) => d + 250);
    }, 250);

    const tick = async () => {
      try {
        const res = await pollDiscordBotPresence(token);
        if (res.guilds.length > 0) {
          setGuilds(res.guilds);
          if (res.guilds.length === 1) setSelectedGuildId(res.guilds[0].id);
        }
      } catch {
        // ignore — keep polling
      }
    };
    tick(); // first call immediately so the spinner doesn't sit empty 5s
    pollTimer.current = window.setInterval(tick, DISCORD_POLL_INTERVAL_MS);
  }

  function stopPolling() {
    setPolling(false);
    if (pollTimer.current) {
      window.clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
    if (durationTimer.current) {
      window.clearInterval(durationTimer.current);
      durationTimer.current = null;
    }
  }

  // ---- handlers ----
  async function handleOpenPortal() {
    await openExternal("https://discord.com/developers/applications");
    setOpenedPortal(true);
  }

  async function handleCopyInvite() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  }

  function commitAndAdvance() {
    setField("discordToken", token);
    setField("guildId", selectedGuildId ?? undefined);
    next();
  }

  function skipForLater() {
    setField("discordToken", token);
    setField("guildId", undefined);
    next();
  }

  // ---- footer per sub-step ----
  const footer = (
    <>
      <Button
        variant="outline"
        onClick={() => {
          if (sub === 1) back();
          else setSub((s) => (s - 1) as SubStep);
        }}
      >
        ← Back
      </Button>
      <div className="flex items-center gap-3">
        {sub === 1 && (
          <Button onClick={() => setSub(2)} disabled={!openedPortal}>
            {openedPortal ? "Continue →" : "Open the portal first"}
          </Button>
        )}
        {sub === 2 && (
          <Button onClick={() => setSub(3)} disabled={!tokenValid}>
            Next: Invite bot to your server →
          </Button>
        )}
        {sub === 3 && (
          <>
            <Button variant="ghost" onClick={skipForLater}>
              I'll do this later
            </Button>
            <Button onClick={commitAndAdvance} disabled={!selectedGuildId}>
              Next: Whisper API key →
            </Button>
          </>
        )}
      </div>
    </>
  );

  return (
    <WizardShell
      title="Create your Discord bot"
      subtitle="Tangerine AI Teams uses a Discord bot to capture team audio. You control the bot — we never touch your server."
      stepLabel={`Step 1 of 5 — Discord bot · ${sub} / 3`}
      footer={footer}
    >
      {sub === 1 && <SubStep1 onOpen={handleOpenPortal} opened={openedPortal} />}

      {sub === 2 && (
        <SubStep2
          token={token}
          setToken={setToken}
          showToken={showToken}
          setShowToken={setShowToken}
          tokenValid={tokenValid}
          tokenTouched={tokenTouched}
        />
      )}

      {sub === 3 && (
        <SubStep3
          inviteUrl={inviteUrl}
          onCopy={handleCopyInvite}
          copied={copied}
          onOpenInvite={() => inviteUrl && openExternal(inviteUrl)}
          polling={polling}
          pollDuration={pollDuration}
          guilds={guilds}
          selectedGuildId={selectedGuildId}
          onSelectGuild={setSelectedGuildId}
        />
      )}
    </WizardShell>
  );
}

// ============================================================
// SW-1.1 — Open Discord Developer Portal
// ============================================================

function SubStep1({ onOpen, opened }: { onOpen: () => void; opened: boolean }) {
  const steps = [
    "Click \"New Application\" in the top-right.",
    "Name it (suggested: \"Tangerine AI Teams — <YourTeam>\").",
    "Open the \"Bot\" tab in the left sidebar.",
    "Click \"Reset Token\" → copy the token.",
    "Scroll to \"Privileged Gateway Intents\" → enable \"Server Members Intent\" → Save.",
  ];
  return (
    <div className="space-y-6">
      <Button size="lg" onClick={onOpen}>
        <ExternalLink size={16} /> {opened ? "Opened — open again" : "Open Discord Developer Portal"}
      </Button>

      <Card>
        <CardContent className="pt-6">
          <ol className="space-y-3">
            {steps.map((s, i) => (
              <li key={i} className="flex gap-3 text-sm text-[var(--ti-ink-700)]">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ti-orange-50)] text-xs font-medium text-[var(--ti-orange-700)]">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {opened && (
        <p className="text-xs italic text-[var(--ti-ink-500)]">
          When you have the bot token copied, click Continue.
        </p>
      )}
    </div>
  );
}

// ============================================================
// SW-1.2 — Paste Bot Token
// ============================================================

interface SubStep2Props {
  token: string;
  setToken: (t: string) => void;
  showToken: boolean;
  setShowToken: (b: boolean) => void;
  tokenValid: boolean;
  tokenTouched: boolean;
}

function SubStep2({
  token,
  setToken,
  showToken,
  setShowToken,
  tokenValid,
  tokenTouched,
}: SubStep2Props) {
  const showError = tokenTouched && !tokenValid;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="discord-token">Bot token</Label>
        <div className="flex items-center gap-2">
          <Input
            id="discord-token"
            type={showToken ? "text" : "password"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="MTAxxxxxxxxxxxxxxxxxxxx.XXXXXX.xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            invalid={showError}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            variant="outline"
            size="icon"
            type="button"
            onClick={() => setShowToken(!showToken)}
            aria-label={showToken ? "Hide token" : "Show token"}
          >
            {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </div>
        {showError && (
          <p className="flex items-center gap-1 text-xs text-[#B83232]">
            <AlertCircle size={12} /> That doesn't look right — make sure you copied the full token.
          </p>
        )}
        {tokenValid && (
          <p className="flex items-center gap-1 text-xs text-[#2D8659]">
            <CheckCircle2 size={12} /> Token format looks valid.
          </p>
        )}
      </div>

      <Card>
        <CardContent className="pt-6 text-sm text-[var(--ti-ink-700)]">
          <p className="mb-2 font-medium text-[var(--ti-ink-900)]">Where it's stored</p>
          <p>
            We save this token to your Windows user environment as <code className="font-mono text-xs">DISCORD_BOT_TOKEN</code>.
            It never leaves your machine — except when the bot itself talks to Discord.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// SW-1.3 — Invite + Poll
// ============================================================

interface SubStep3Props {
  inviteUrl: string | null;
  onCopy: () => void;
  copied: boolean;
  onOpenInvite: () => void;
  polling: boolean;
  pollDuration: number;
  guilds: { id: string; name: string }[];
  selectedGuildId: string | null;
  onSelectGuild: (id: string) => void;
}

function SubStep3({
  inviteUrl,
  onCopy,
  copied,
  onOpenInvite,
  polling,
  pollDuration,
  guilds,
  selectedGuildId,
  onSelectGuild,
}: SubStep3Props) {
  const showHint = polling && pollDuration > DISCORD_POLL_HINT_AFTER_MS && guilds.length === 0;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label>OAuth invite URL</Label>
        {inviteUrl ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 truncate rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-200)] px-3 py-2 font-mono text-xs text-[var(--ti-ink-700)]">
              {inviteUrl}
            </div>
            <Button variant="outline" size="icon" onClick={onCopy} aria-label="Copy invite URL">
              {copied ? <CheckCircle2 size={16} /> : <Copy size={16} />}
            </Button>
            <Button onClick={onOpenInvite}>
              <ExternalLink size={16} /> Open invite
            </Button>
          </div>
        ) : (
          <p className="text-xs italic text-[var(--ti-ink-500)]">
            Couldn't decode the bot's client ID from your token. Try re-pasting it on the previous step.
          </p>
        )}
      </div>

      <Card>
        <CardContent className="pt-6">
          {guilds.length === 0 ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3 text-sm text-[var(--ti-ink-700)]">
                {polling ? (
                  <Loader2 size={16} className="animate-spin text-[var(--ti-orange-500)]" />
                ) : (
                  <AlertCircle size={16} className="text-[var(--ti-ink-500)]" />
                )}
                <span>Waiting for bot to appear in your server...</span>
              </div>
              {showHint && (
                <p className="text-xs italic text-[var(--ti-ink-500)]">
                  Discord may take up to 10 seconds to register the bot — keep this window open.
                </p>
              )}
              <p className="text-xs text-[var(--ti-ink-500)]">
                Polling every 5 seconds (Discord rate limit safe).
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-[#2D8659]">
                <CheckCircle2 size={16} />
                <span>
                  Bot detected in {guilds.length} server{guilds.length === 1 ? "" : "s"}.
                </span>
              </div>
              {guilds.length > 1 && (
                <div className="space-y-2">
                  <Label>Choose your team server</Label>
                  <div className="space-y-1">
                    {guilds.map((g) => (
                      <label
                        key={g.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors duration-fast",
                          selectedGuildId === g.id
                            ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)]"
                            : "border-[var(--ti-border-default)] hover:bg-[var(--ti-paper-200)]"
                        )}
                      >
                        <input
                          type="radio"
                          name="guild"
                          checked={selectedGuildId === g.id}
                          onChange={() => onSelectGuild(g.id)}
                          className="accent-[var(--ti-orange-500)]"
                        />
                        <span className="font-medium">{g.name}</span>
                        <span className="ml-auto font-mono text-xs text-[var(--ti-ink-500)]">
                          {g.id}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
