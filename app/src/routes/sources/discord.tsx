import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Download,
  Plus,
  X,
  Mic,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { useStore, type TeamMember, type MeetingConfig } from "@/lib/store";
import {
  buildInviteUrl,
  extractClientId,
  isPlausibleBotToken,
  DISCORD_POLL_INTERVAL_MS,
} from "@/lib/discord";
import {
  openExternal,
  pollDiscordBotPresence,
  detectClaudeCli,
  detectNodeRuntime,
  validateWhisperKey,
  downloadWhisperModel,
  getWhisperModelStatus,
  finishWizard,
  type WhisperModelStatus,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

const ALIAS_RE = /^[a-z][a-z0-9_]*$/;
const DISCORD_ID_RE = /^\d{17,20}$/;

type SectionId = "discord" | "transcription" | "claude" | "team";

function emptyTeamRow(): TeamMember {
  return { alias: "", displayName: "", discordId: "" };
}

export default function MeetingSetupRoute() {
  const navigate = useNavigate();
  const stored = useStore((s) => s.skills.meetingConfig);
  const setMeetingConfig = useStore((s) => s.skills.setMeetingConfig);
  const pushToast = useStore((s) => s.ui.pushToast);

  // ---------- local form state, seeded from stored ----------
  const [discordToken, setDiscordToken] = useState(stored.discordToken ?? "");
  const [showToken, setShowToken] = useState(false);
  const [guildId, setGuildId] = useState<string | null>(stored.guildId ?? null);
  const [guilds, setGuilds] = useState<{ id: string; name: string }[]>([]);
  const [polling, setPolling] = useState(false);
  const [copiedInvite, setCopiedInvite] = useState(false);

  const [whisperMode, setWhisperMode] = useState<"local" | "openai">(
    stored.whisperMode ?? "local",
  );
  const [whisperKey, setWhisperKey] = useState(stored.whisperKey ?? "");
  const [showWhisperKey, setShowWhisperKey] = useState(false);
  const [whisperKeyError, setWhisperKeyError] = useState<string | null>(null);
  const [validatingKey, setValidatingKey] = useState(false);
  const [modelStatus, setModelStatus] = useState<WhisperModelStatus>({
    state: "unknown",
    path: null,
    bytes: 0,
  });
  const [downloading, setDownloading] = useState(false);
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const downloadUnsub = useRef<null | (() => void)>(null);

  const [claudePath, setClaudePath] = useState<string | null>(stored.claudeCliPath ?? null);
  const [claudeVersion, setClaudeVersion] = useState<string | null>(
    stored.claudeCliVersion ?? null,
  );
  const [claudeChecking, setClaudeChecking] = useState(false);
  const [nodePath, setNodePath] = useState<string | null>(stored.nodePath ?? null);
  const [nodeVersion, setNodeVersion] = useState<string | null>(stored.nodeVersion ?? null);
  const [nodeMeetsMin, setNodeMeetsMin] = useState<boolean>(stored.nodeAvailable ?? false);
  const [nodeChecking, setNodeChecking] = useState(false);

  const [team, setTeam] = useState<TeamMember[]>(
    stored.team && stored.team.length > 0 ? stored.team : [emptyTeamRow()],
  );

  const [saving, setSaving] = useState(false);

  // ---------- discord token + polling ----------
  const tokenValid = isPlausibleBotToken(discordToken);
  const clientId = extractClientId(discordToken);
  const inviteUrl = clientId ? buildInviteUrl(clientId) : null;

  useEffect(() => {
    if (!tokenValid) {
      setPolling(false);
      return;
    }
    let cancelled = false;
    setPolling(true);
    let timer: number | null = null;
    const tick = async () => {
      try {
        const r = await pollDiscordBotPresence(discordToken);
        if (cancelled) return;
        if (r.guilds.length > 0) {
          setGuilds(r.guilds);
          if (r.guilds.length === 1 && !guildId) setGuildId(r.guilds[0].id);
        }
      } catch {
        /* keep polling */
      }
    };
    void tick();
    timer = window.setInterval(tick, DISCORD_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      setPolling(false);
      if (timer) window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discordToken, tokenValid]);

  // ---------- whisper local model status on mount ----------
  useEffect(() => {
    void getWhisperModelStatus().then(setModelStatus);
    return () => downloadUnsub.current?.();
  }, []);

  async function handleDownloadModel() {
    setDownloadError(null);
    setDownloading(true);
    setDownloadBytes(0);
    try {
      const handle = await downloadWhisperModel("small", (evt) => {
        if (evt.event === "progress") setDownloadBytes(evt.downloaded);
        if (evt.event === "error") {
          setDownloadError(evt.message);
          pushToast("error", `Whisper download failed: ${evt.message}`);
        }
      });
      downloadUnsub.current = handle.unsubscribe;
      const final = await handle.completion;
      setModelStatus(final);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // eslint-disable-next-line no-console
      console.error("[meeting] handleDownloadModel:", e);
      setDownloadError(msg);
      pushToast("error", `Whisper download failed: ${msg}`);
    } finally {
      setDownloading(false);
    }
  }

  // ---------- claude + node detection ----------
  async function detectPrereqs() {
    setClaudeChecking(true);
    setNodeChecking(true);
    try {
      const [c, n] = await Promise.all([detectClaudeCli(), detectNodeRuntime()]);
      setClaudePath(c.path);
      setClaudeVersion(c.version);
      setNodePath(n.path);
      setNodeVersion(n.version);
      setNodeMeetsMin(n.found && n.meets_min);
    } finally {
      setClaudeChecking(false);
      setNodeChecking(false);
    }
  }

  // Auto-detect once on mount if not already filled.
  useEffect(() => {
    if (!claudePath || !nodePath) {
      void detectPrereqs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- team ----------
  function updateTeam(idx: number, patch: Partial<TeamMember>) {
    setTeam((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addTeamRow() {
    setTeam((rows) => [...rows, emptyTeamRow()]);
  }
  function removeTeamRow(idx: number) {
    setTeam((rows) => (rows.length === 1 ? rows : rows.filter((_, i) => i !== idx)));
  }

  // ---------- per-section validity ----------
  const discordOk = tokenValid && !!guildId;
  const transcriptionOk =
    whisperMode === "local"
      ? modelStatus.state === "ready"
      : whisperKey.startsWith("sk-") && whisperKey.length >= 40;
  const claudeOk = !!claudePath;
  const teamErrors = validateTeam(team);
  const teamOk = teamErrors.length === 0;
  const allOk = discordOk && transcriptionOk && claudeOk && teamOk;

  // Pre-expand the first incomplete section.
  const initialOpen: SectionId =
    !discordOk
      ? "discord"
      : !transcriptionOk
        ? "transcription"
        : !claudeOk
          ? "claude"
          : !teamOk
            ? "team"
            : "discord";
  const [openSection, setOpenSection] = useState<SectionId | null>(initialOpen);

  // ---------- save ----------
  async function handleSave() {
    if (!allOk) return;
    if (whisperMode === "openai") {
      setValidatingKey(true);
      try {
        const r = await validateWhisperKey(whisperKey);
        if (!r.ok) {
          setWhisperKeyError(r.error ?? "Key didn't validate.");
          setOpenSection("transcription");
          return;
        }
      } finally {
        setValidatingKey(false);
      }
    }

    setSaving(true);
    try {
      const next: MeetingConfig = {
        discordToken,
        guildId: guildId ?? undefined,
        whisperMode,
        whisperKey: whisperMode === "openai" ? whisperKey : undefined,
        claudeCliPath: claudePath ?? undefined,
        claudeCliVersion: claudeVersion ?? undefined,
        nodeAvailable: nodeMeetsMin,
        nodeVersion: nodeVersion ?? undefined,
        nodePath: nodePath ?? undefined,
        team,
      };
      setMeetingConfig(next);
      // Persist via existing Tauri pipeline so the live meeting UI keeps working.
      await finishWizard({
        discordToken: next.discordToken,
        guildId: next.guildId,
        whisperMode: next.whisperMode,
        whisperKey: next.whisperKey,
        claudeCliPath: next.claudeCliPath,
        claudeCliVersion: next.claudeCliVersion,
        nodeAvailable: next.nodeAvailable,
        nodeVersion: next.nodeVersion,
        nodePath: next.nodePath,
        team: next.team,
      });
      pushToast("success", "Discord source set up. Memory updates from now on.");
      navigate("/memory");
    } catch (e) {
      pushToast("error", `Apply failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
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
          <Mic size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Discord
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Set up
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · Discord</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Set up the Discord source
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Four sections. Fill the ones that aren't ticked. The Discord bot reads voice
          channels, transcribes via local Whisper, and writes a memory file per call to
          your memory dir.
        </p>

        <div className="mt-8 space-y-3">
          <Section
            id="discord"
            title="Discord bot"
            done={discordOk}
            open={openSection === "discord"}
            onToggle={() => setOpenSection(openSection === "discord" ? null : "discord")}
          >
            <DiscordSection
              token={discordToken}
              setToken={setDiscordToken}
              showToken={showToken}
              setShowToken={setShowToken}
              tokenValid={tokenValid}
              inviteUrl={inviteUrl}
              copiedInvite={copiedInvite}
              onCopyInvite={async () => {
                if (!inviteUrl) return;
                try {
                  await navigator.clipboard.writeText(inviteUrl);
                  setCopiedInvite(true);
                  window.setTimeout(() => setCopiedInvite(false), 2000);
                } catch {
                  /* clipboard unavailable */
                }
              }}
              onOpenInvite={() => inviteUrl && openExternal(inviteUrl)}
              polling={polling}
              guilds={guilds}
              guildId={guildId}
              setGuildId={setGuildId}
            />
          </Section>

          <Section
            id="transcription"
            title="Transcription"
            done={transcriptionOk}
            open={openSection === "transcription"}
            onToggle={() =>
              setOpenSection(openSection === "transcription" ? null : "transcription")
            }
          >
            <TranscriptionSection
              mode={whisperMode}
              setMode={setWhisperMode}
              status={modelStatus}
              downloading={downloading}
              downloadBytes={downloadBytes}
              downloadError={downloadError}
              onDownload={handleDownloadModel}
              key1={whisperKey}
              setKey1={setWhisperKey}
              showKey={showWhisperKey}
              setShowKey={setShowWhisperKey}
              keyError={whisperKeyError}
              validating={validatingKey}
            />
          </Section>

          <Section
            id="claude"
            title="Claude + Node runtime"
            done={claudeOk && nodeMeetsMin}
            open={openSection === "claude"}
            onToggle={() => setOpenSection(openSection === "claude" ? null : "claude")}
          >
            <ClaudeSection
              claudePath={claudePath}
              claudeVersion={claudeVersion}
              claudeChecking={claudeChecking}
              nodePath={nodePath}
              nodeVersion={nodeVersion}
              nodeMeetsMin={nodeMeetsMin}
              nodeChecking={nodeChecking}
              onRecheck={detectPrereqs}
            />
          </Section>

          <Section
            id="team"
            title="Team members"
            done={teamOk}
            open={openSection === "team"}
            onToggle={() => setOpenSection(openSection === "team" ? null : "team")}
          >
            <TeamSection
              team={team}
              update={updateTeam}
              add={addTeamRow}
              remove={removeTeamRow}
              errors={teamErrors}
            />
          </Section>
        </div>
      </main>

      {/* Sticky save bar */}
      <div className="ti-no-select fixed bottom-0 left-0 right-0 border-t border-stone-200 bg-stone-50/95 backdrop-blur dark:border-stone-800 dark:bg-stone-950/95">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-8 py-4">
          <span className="text-xs text-stone-500 dark:text-stone-400">
            {allOk
              ? "All sections complete."
              : `${[discordOk, transcriptionOk, claudeOk, teamOk].filter(Boolean).length} of 4 sections complete.`}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate("/memory")}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={!allOk || saving}>
              {saving ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Applying…
                </>
              ) : (
                "Apply"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function validateTeam(rows: TeamMember[]): string[] {
  const errs: string[] = [];
  if (rows.length === 0) errs.push("At least one team member required.");
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.alias.trim()) {
      errs.push("Every row needs an alias.");
      break;
    }
    if (!ALIAS_RE.test(r.alias)) {
      errs.push(`Alias "${r.alias}" must match ^[a-z][a-z0-9_]*$.`);
    }
    if (seen.has(r.alias)) errs.push(`Duplicate alias: ${r.alias}.`);
    seen.add(r.alias);
    if (!r.displayName.trim()) {
      errs.push(`"${r.alias}" needs a display name.`);
    }
    if (r.discordId && !DISCORD_ID_RE.test(r.discordId)) {
      errs.push(`Discord ID "${r.discordId}" should be 17–20 digits.`);
    }
  }
  return errs;
}

// ============================================================
// Section wrapper
// ============================================================

interface SectionProps {
  id: SectionId;
  title: string;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({ title, done, open, onToggle, children }: SectionProps) {
  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left"
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronDown size={16} className="text-[var(--ti-ink-500)]" />
          ) : (
            <ChevronRight size={16} className="text-[var(--ti-ink-500)]" />
          )}
          <span className="font-medium text-[var(--ti-ink-900)]">{title}</span>
        </div>
        {done ? (
          <span className="flex items-center gap-1 text-xs text-[var(--ti-success)]">
            <CheckCircle2 size={14} /> Complete
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-[var(--ti-ink-500)]">
            <AlertCircle size={14} /> Needs setup
          </span>
        )}
      </button>
      {open && <CardContent className="pt-0 pb-6">{children}</CardContent>}
    </Card>
  );
}

// ============================================================
// Discord section
// ============================================================

interface DiscordSectionProps {
  token: string;
  setToken: (t: string) => void;
  showToken: boolean;
  setShowToken: (b: boolean) => void;
  tokenValid: boolean;
  inviteUrl: string | null;
  copiedInvite: boolean;
  onCopyInvite: () => void;
  onOpenInvite: () => void;
  polling: boolean;
  guilds: { id: string; name: string }[];
  guildId: string | null;
  setGuildId: (id: string | null) => void;
}

function DiscordSection(p: DiscordSectionProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--ti-ink-700)]">
        Tangerine uses a Discord bot to capture team audio. Create one at the Discord
        Developer Portal, paste its token here, then invite it to your server.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => openExternal("https://discord.com/developers/applications")}
      >
        <ExternalLink size={14} /> Open Developer Portal
      </Button>

      <div className="space-y-2">
        <Label htmlFor="discord-token">Bot token</Label>
        <div className="flex items-center gap-2">
          <Input
            id="discord-token"
            type={p.showToken ? "text" : "password"}
            value={p.token}
            onChange={(e) => p.setToken(e.target.value)}
            placeholder="MTAxxxxxxxxxxxxxxxxxxxx.XXXXXX.xxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            invalid={p.token.length > 0 && !p.tokenValid}
            autoComplete="off"
            spellCheck={false}
          />
          <Button
            variant="outline"
            size="icon"
            type="button"
            onClick={() => p.setShowToken(!p.showToken)}
            aria-label={p.showToken ? "Hide token" : "Show token"}
          >
            {p.showToken ? <EyeOff size={16} /> : <Eye size={16} />}
          </Button>
        </div>
        {p.token.length > 0 && !p.tokenValid && (
          <p className="flex items-center gap-1 text-xs text-[var(--ti-danger)]">
            <AlertCircle size={12} /> Token format invalid.
          </p>
        )}
        {p.tokenValid && (
          <p className="flex items-center gap-1 text-xs text-[var(--ti-success)]">
            <CheckCircle2 size={12} /> Token format looks valid.
          </p>
        )}
      </div>

      {p.tokenValid && (
        <div className="space-y-2">
          <Label>OAuth invite URL</Label>
          {p.inviteUrl ? (
            <div className="flex items-center gap-2">
              <div className="flex-1 truncate rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-200)] px-3 py-2 font-mono text-xs text-[var(--ti-ink-700)]">
                {p.inviteUrl}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={p.onCopyInvite}
                aria-label="Copy invite URL"
              >
                {p.copiedInvite ? <CheckCircle2 size={16} /> : <Copy size={16} />}
              </Button>
              <Button onClick={p.onOpenInvite}>
                <ExternalLink size={16} /> Invite
              </Button>
            </div>
          ) : (
            <p className="text-xs italic text-[var(--ti-ink-500)]">
              Could not decode bot client ID — re-paste the token.
            </p>
          )}
        </div>
      )}

      {p.tokenValid && (
        <Card>
          <CardContent className="pt-6">
            {p.guilds.length === 0 ? (
              <div className="flex items-center gap-3 text-sm text-[var(--ti-ink-700)]">
                {p.polling ? (
                  <Loader2 size={16} className="animate-spin text-[var(--ti-orange-500)]" />
                ) : (
                  <AlertCircle size={16} className="text-[var(--ti-ink-500)]" />
                )}
                <span>Waiting for bot to appear in your server…</span>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-[var(--ti-success)]">
                  <CheckCircle2 size={16} />
                  <span>
                    Bot detected in {p.guilds.length} server{p.guilds.length === 1 ? "" : "s"}.
                  </span>
                </div>
                {p.guilds.length > 1 && (
                  <div className="space-y-2">
                    <Label>Choose your team server</Label>
                    {p.guilds.map((g) => (
                      <label
                        key={g.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors duration-fast",
                          p.guildId === g.id
                            ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)]"
                            : "border-[var(--ti-border-default)] hover:bg-[var(--ti-paper-200)]",
                        )}
                      >
                        <input
                          type="radio"
                          name="guild"
                          checked={p.guildId === g.id}
                          onChange={() => p.setGuildId(g.id)}
                          className="accent-[var(--ti-orange-500)]"
                        />
                        <span className="font-medium">{g.name}</span>
                        <span className="ml-auto font-mono text-xs text-[var(--ti-ink-500)]">
                          {g.id}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ============================================================
// Transcription section
// ============================================================

interface TranscriptionSectionProps {
  mode: "local" | "openai";
  setMode: (m: "local" | "openai") => void;
  status: WhisperModelStatus;
  downloading: boolean;
  downloadBytes: number;
  downloadError: string | null;
  onDownload: () => void;
  key1: string;
  setKey1: (s: string) => void;
  showKey: boolean;
  setShowKey: (b: boolean) => void;
  keyError: string | null;
  validating: boolean;
}

function TranscriptionSection(p: TranscriptionSectionProps) {
  const localReady = p.status.state === "ready";
  const localKeyValid = p.key1.startsWith("sk-") && p.key1.length >= 40;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <label className="flex items-start gap-2">
              <input
                type="radio"
                checked={p.mode === "local"}
                onChange={() => p.setMode("local")}
                className="mt-1 accent-[var(--ti-orange-500)]"
              />
              <div>
                <p className="font-medium text-[var(--ti-ink-900)]">
                  Local Whisper (recommended)
                </p>
                <p className="text-sm text-[var(--ti-ink-700)]">
                  faster-whisper, small model, int8 quantised. ~244 MB on disk. Runs on
                  CPU. No API key, $0/min, audio never leaves your machine.
                </p>
              </div>
            </label>
            {localReady && (
              <span className="flex items-center gap-1 whitespace-nowrap text-xs text-[var(--ti-success)]">
                <CheckCircle2 size={14} /> Ready
              </span>
            )}
          </div>

          {p.mode === "local" && !localReady && !p.downloading && (
            <Button onClick={p.onDownload}>
              <Download size={16} /> Download model (244 MB, one-time)
            </Button>
          )}
          {p.mode === "local" && p.downloading && (
            <div className="space-y-1">
              <div className="h-2 w-full rounded bg-[var(--ti-ink-100)]">
                <div
                  className="h-2 rounded bg-[var(--ti-orange-500)]"
                  style={{
                    width: `${Math.min(100, (p.downloadBytes / (244 * 1024 * 1024)) * 100)}%`,
                  }}
                />
              </div>
              <p className="text-xs text-[var(--ti-ink-700)]">
                {(p.downloadBytes / (1024 * 1024)).toFixed(1)} MB downloaded…
              </p>
            </div>
          )}
          {p.downloadError && (
            <p className="flex items-center gap-1 text-xs text-[var(--ti-danger)]">
              <AlertCircle size={12} /> {p.downloadError}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-3">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              checked={p.mode === "openai"}
              onChange={() => p.setMode("openai")}
              className="mt-1 accent-[var(--ti-orange-500)]"
            />
            <div>
              <p className="font-medium text-[var(--ti-ink-900)]">OpenAI Whisper (cloud)</p>
              <p className="text-sm text-[var(--ti-ink-700)]">
                Opt-in cloud Whisper for max accuracy or weak CPUs. ~$0.006/min ($0.36/hr).
                Audio is sent to OpenAI.
              </p>
            </div>
          </label>

          {p.mode === "openai" && (
            <div className="space-y-2">
              <Label htmlFor="whisper-key">OpenAI API key</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="whisper-key"
                  type={p.showKey ? "text" : "password"}
                  value={p.key1}
                  onChange={(e) => p.setKey1(e.target.value)}
                  placeholder="sk-…"
                  invalid={!!p.keyError}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  onClick={() => p.setShowKey(!p.showKey)}
                  aria-label={p.showKey ? "Hide key" : "Show key"}
                >
                  {p.showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </Button>
              </div>
              {p.keyError && (
                <p className="flex items-center gap-1 text-xs text-[var(--ti-danger)]">
                  <AlertCircle size={12} /> {p.keyError}
                </p>
              )}
              {localKeyValid && !p.keyError && (
                <p className="flex items-center gap-1 text-xs text-[var(--ti-success)]">
                  <CheckCircle2 size={12} /> Key format valid.
                </p>
              )}
              <button
                className="text-xs text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                onClick={() => openExternal("https://platform.openai.com/api-keys")}
                type="button"
              >
                Where do I get this? <ExternalLink size={10} className="inline" />
              </button>
              {p.validating && (
                <p className="flex items-center gap-1 text-xs text-[var(--ti-ink-500)]">
                  <Loader2 size={12} className="animate-spin" /> Validating…
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Claude + Node section
// ============================================================

interface ClaudeSectionProps {
  claudePath: string | null;
  claudeVersion: string | null;
  claudeChecking: boolean;
  nodePath: string | null;
  nodeVersion: string | null;
  nodeMeetsMin: boolean;
  nodeChecking: boolean;
  onRecheck: () => void;
}

function ClaudeSection(p: ClaudeSectionProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--ti-ink-700)]">
        Tangerine uses your existing Claude Code subscription and your local Node 20+
        runtime. Both must be on PATH.
      </p>
      <Button variant="outline" size="sm" onClick={p.onRecheck}>
        Re-check
      </Button>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
            Claude Code CLI
          </div>
          {p.claudeChecking ? (
            <div className="flex items-center gap-2 text-sm text-[var(--ti-ink-700)]">
              <Loader2 size={16} className="animate-spin text-[var(--ti-orange-500)]" />
              <span>Looking for the claude CLI…</span>
            </div>
          ) : p.claudePath ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-[var(--ti-success)]">
                <CheckCircle2 size={16} /> Detected.
              </div>
              <dl className="space-y-1 text-xs text-[var(--ti-ink-700)]">
                <div className="flex gap-2">
                  <dt className="w-16 text-[var(--ti-ink-500)]">Path</dt>
                  <dd className="break-all font-mono">{p.claudePath}</dd>
                </div>
                {p.claudeVersion && (
                  <div className="flex gap-2">
                    <dt className="w-16 text-[var(--ti-ink-500)]">Version</dt>
                    <dd className="font-mono">{p.claudeVersion}</dd>
                  </div>
                )}
              </dl>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-[var(--ti-danger)]">
              <AlertCircle size={16} /> claude CLI not found on PATH.{" "}
              <button
                className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                onClick={() => openExternal("https://claude.ai/code")}
                type="button"
              >
                Install <ExternalLink size={10} className="inline" />
              </button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
            Node.js Runtime (≥ 20.0.0)
          </div>
          {p.nodeChecking ? (
            <div className="flex items-center gap-2 text-sm text-[var(--ti-ink-700)]">
              <Loader2 size={16} className="animate-spin text-[var(--ti-orange-500)]" />
              <span>Looking for node…</span>
            </div>
          ) : p.nodeMeetsMin ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm text-[var(--ti-success)]">
                <CheckCircle2 size={16} /> Node {p.nodeVersion}.
              </div>
              {p.nodePath && (
                <p className="break-all font-mono text-xs text-[var(--ti-ink-700)]">
                  {p.nodePath}
                </p>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-[var(--ti-danger)]">
              <AlertCircle size={16} />
              {p.nodePath
                ? `Node ${p.nodeVersion ?? "?"} found, but < 20.`
                : "Node not found on PATH."}{" "}
              <button
                className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                onClick={() => openExternal("https://nodejs.org/")}
                type="button"
              >
                Install <ExternalLink size={10} className="inline" />
              </button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Team section
// ============================================================

interface TeamSectionProps {
  team: TeamMember[];
  update: (idx: number, patch: Partial<TeamMember>) => void;
  add: () => void;
  remove: (idx: number) => void;
  errors: string[];
}

function TeamSection(p: TeamSectionProps) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--ti-ink-700)]">
        Add the people who will join meetings. Each needs an alias and display name; Discord
        ID is optional.
      </p>

      <div className="grid grid-cols-[1fr_1fr_1fr_auto] gap-3 text-xs text-[var(--ti-ink-500)]">
        <Label>Alias</Label>
        <Label>Display name</Label>
        <Label>Discord ID</Label>
        <span />
      </div>

      {p.team.map((r, idx) => {
        const aliasBad = r.alias.length > 0 && !ALIAS_RE.test(r.alias);
        const idBad = r.discordId.length > 0 && !DISCORD_ID_RE.test(r.discordId);
        return (
          <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] items-start gap-3">
            <Input
              placeholder="daizhe"
              value={r.alias}
              onChange={(e) => p.update(idx, { alias: e.target.value })}
              invalid={aliasBad}
            />
            <Input
              placeholder="Daizhe Zou"
              value={r.displayName}
              onChange={(e) => p.update(idx, { displayName: e.target.value })}
            />
            <Input
              placeholder="123456789012345678"
              value={r.discordId}
              onChange={(e) => p.update(idx, { discordId: e.target.value })}
              invalid={idBad}
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => p.remove(idx)}
              disabled={p.team.length === 1}
              aria-label="Remove row"
            >
              <X size={16} />
            </Button>
          </div>
        );
      })}

      <Button variant="outline" size="sm" onClick={p.add}>
        <Plus size={14} /> Add member
      </Button>

      {p.errors.length > 0 && (
        <ul className="space-y-1">
          {p.errors.map((e, i) => (
            <li key={i} className="flex items-center gap-1 text-xs text-[var(--ti-danger)]">
              <AlertCircle size={12} /> {e}
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs italic text-[var(--ti-ink-500)]">
        To copy a Discord ID: enable Developer Mode (Settings → Advanced), then right-click a
        user → Copy User ID.
      </p>
    </div>
  );
}
