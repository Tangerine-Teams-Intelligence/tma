import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, AlertCircle, Github, FolderOpen, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import { gitCheck, gitClone, gitInitAndPush, generateInvite, syncStart } from "@/lib/git";
import { ghDeviceFlowStart, ghDeviceFlowPollUntilReady, ghCreateRepo } from "@/lib/github";
import { openExternal } from "@/lib/tauri";
import { resolveMemoryRoot } from "@/lib/tauri";
// === v2.0-beta.3 onboarding cut ===
// Skip mode-pick when the user already has memory content on disk
// (returning user) — they shouldn't be forced through Solo / Team /
// Existing again. New users default to Solo and land on home directly.
import { userFacingFoldersEmpty } from "@/lib/memory";
// === end v2.0-beta.3 onboarding cut ===
import { InviteLinkModal } from "@/components/InviteLinkModal";

type Mode = "create" | "existing" | "solo";
type Phase = "pick" | "device" | "polling" | "creating" | "cloning" | "invite" | "error";

/**
 * First-run team setup. Three branches:
 *
 *   1. Create new repo (champion path)
 *      → device-flow OAuth → ghCreateRepo → gitInitAndPush → generate invite
 *      → InviteLinkModal → /memory.
 *
 *   2. Use existing repo
 *      → paste clone URL → device-flow OAuth → gitClone → /memory.
 *
 *   3. Solo / local
 *      → set memoryConfig.mode = "solo" → /memory.
 *
 * The whole experience is gated on `git_check` — if git is missing we show
 * an install link instead of letting the underlying clone error leak out.
 */
export default function OnboardingTeamRoute() {
  const navigate = useNavigate();
  const setMemoryConfig = useStore((s) => s.ui.setMemoryConfig);
  const setMemoryRoot = useStore((s) => s.ui.setMemoryRoot);
  const pushToast = useStore((s) => s.ui.pushToast);
  // === v2.0-beta.3 onboarding cut ===
  // memoryConfigMode is undefined for first-launch users only. We use it
  // as the "should we even render the picker?" gate — paired with the
  // disk-state check below, returning users skip the picker entirely.
  const memoryConfigMode = useStore((s) => s.ui.memoryConfig.mode);
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  // === end v2.0-beta.3 onboarding cut ===

  const [mode, setMode] = useState<Mode>("solo");
  const [phase, setPhase] = useState<Phase>("pick");
  const [error, setError] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<{ available: boolean; install_url: string } | null>(null);
  const [existingUrl, setExistingUrl] = useState("");
  const [device, setDevice] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const [inviteUri, setInviteUri] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void gitCheck().then((r) => {
      if (cancel) return;
      setGitStatus({ available: r.available, install_url: r.install_url });
    });
    return () => {
      cancel = true;
    };
  }, []);

  // === v2.0-beta.3 onboarding cut ===
  // Skip the picker entirely when one of two conditions holds:
  //   1. The user already picked a mode in a prior session
  //      (memoryConfigMode !== undefined) — returning user, the picker
  //      is moot.
  //   2. The user-facing memory folders already have content. v2.0
  //      collapses the 3-way picker into "Solo by default + opt-in to
  //      Team via Settings", and the disk being non-empty is the
  //      strongest signal that the user has been here before regardless
  //      of whether the persisted store has the mode set (e.g. wiped
  //      localStorage on a returning install).
  // In either case we set memoryConfig.mode = "solo" silently and
  // navigate home; the user can flip to Team mode any time from
  // Settings. The team setup is still reachable via the explicit
  // /onboarding-team route → "I have a team" affordance below for net-
  // new users who want it.
  useEffect(() => {
    let cancel = false;
    void (async () => {
      // Case 1 — returning user with a recorded mode.
      if (memoryConfigMode !== undefined) {
        if (cancel) return;
        navigate("/today", { replace: true });
        return;
      }
      // Case 2 — disk has content. Solo-default + skip.
      try {
        const info = await resolveMemoryRoot();
        if (cancel) return;
        const root =
          info.path && !info.path.startsWith("~") ? info.path : memoryRoot;
        const empty = await userFacingFoldersEmpty(root);
        if (cancel) return;
        if (!empty) {
          setMemoryConfig({ mode: "solo" });
          navigate("/today", { replace: true });
        }
      } catch {
        // Tauri bridge missing (browser dev / vitest) → fall through to
        // the picker so dev-mode behaviour stays predictable.
      }
    })();
    return () => {
      cancel = true;
    };
  }, [memoryConfigMode, memoryRoot, navigate, setMemoryConfig]);
  // === end v2.0-beta.3 onboarding cut ===

  function chooseSolo() {
    setMemoryConfig({ mode: "solo" });
    pushToast("info", "Memory stays on this machine. Switch to team mode any time from Settings.");
    navigate("/memory", { replace: true });
  }

  async function chooseCreateNew() {
    setError(null);
    setPhase("device");
    try {
      const start = await ghDeviceFlowStart();
      setDevice({ user_code: start.user_code, verification_uri: start.verification_uri });
      // Open the device-code page so the user can paste the code right away.
      void openExternal(start.verification_uri);
      setPhase("polling");
      const login = await ghDeviceFlowPollUntilReady(start);
      setPhase("creating");
      const repo = await ghCreateRepo({ login, private: true });
      // Champion's local clone path: ~/Documents/Tangerine/<repo-name>.
      const root = await resolveMemoryRoot();
      // Best-effort: derive a local clone dir under the user's docs.
      const localClone = deriveLocalClonePath(root.path, repo.name);
      await gitInitAndPush({ repo: localClone, remoteUrl: repo.clone_url });
      // Save config + start sync.
      setMemoryConfig({
        mode: "team",
        repoUrl: repo.clone_url,
        repoLocalPath: localClone,
        githubLogin: login,
      });
      setMemoryRoot(`${localClone}/memory`);
      void syncStart({ repoPath: localClone, login });
      // Build the invite link and surface the modal.
      const invite = await generateInvite({ repoUrl: repo.clone_url });
      setMemoryConfig({ inviteUri: invite.uri, inviteExpiresAt: invite.expires_at });
      setInviteUri(invite.uri);
      setPhase("invite");
    } catch (e) {
      setError(humanize(e));
      setPhase("error");
    }
  }

  async function chooseExisting() {
    if (!existingUrl.trim()) {
      setError("Paste a GitHub clone URL first.");
      return;
    }
    setError(null);
    setPhase("device");
    try {
      const start = await ghDeviceFlowStart();
      setDevice({ user_code: start.user_code, verification_uri: start.verification_uri });
      void openExternal(start.verification_uri);
      setPhase("polling");
      const login = await ghDeviceFlowPollUntilReady(start);
      setPhase("cloning");
      const root = await resolveMemoryRoot();
      const repoName = inferRepoName(existingUrl);
      const localClone = deriveLocalClonePath(root.path, repoName);
      await gitClone({ url: existingUrl.trim(), dest: localClone });
      setMemoryConfig({
        mode: "team",
        repoUrl: existingUrl.trim(),
        repoLocalPath: localClone,
        githubLogin: login,
      });
      setMemoryRoot(`${localClone}/memory`);
      void syncStart({ repoPath: localClone, login });
      pushToast("success", "Team memory connected.");
      navigate("/memory", { replace: true });
    } catch (e) {
      setError(humanize(e));
      setPhase("error");
    }
  }

  function finishInvite() {
    setInviteUri(null);
    pushToast("success", "Team memory ready.");
    navigate("/memory", { replace: true });
  }

  // ---------- render ----------

  if (gitStatus && !gitStatus.available) {
    return (
      <FullPage>
        <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
          We need git on this machine first
        </h1>
        <p className="mt-3 text-sm text-stone-700 dark:text-stone-300">
          Tangerine syncs your team memory through git. It's a 60-second install
          and you only do it once. Most developers already have it.
        </p>
        <div className="mt-6 flex gap-3">
          <Button onClick={() => openExternal(gitStatus.install_url)}>
            Install git <ArrowRight size={14} />
          </Button>
          <Button variant="outline" onClick={chooseSolo}>
            Skip — stay solo for now
          </Button>
        </div>
      </FullPage>
    );
  }

  if (phase === "device" || phase === "polling") {
    return (
      <FullPage>
        <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
          Sign in to GitHub
        </h1>
        <p className="mt-3 text-sm text-stone-700 dark:text-stone-300">
          We opened the GitHub login page. Type this code:
        </p>
        <div className="mt-6 rounded-md border border-stone-300 bg-stone-100 px-4 py-4 dark:border-stone-700 dark:bg-stone-900">
          <p className="font-mono text-3xl tracking-widest text-stone-900 dark:text-stone-100">
            {device?.user_code ?? "—"}
          </p>
          <p className="mt-2 break-all font-mono text-[11px] text-stone-500 dark:text-stone-400">
            at {device?.verification_uri ?? "https://github.com/login/device"}
          </p>
        </div>
        <p className="mt-6 flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400">
          <Loader2 size={12} className="animate-spin" /> Waiting for GitHub…
        </p>
      </FullPage>
    );
  }

  if (phase === "creating" || phase === "cloning") {
    return (
      <FullPage>
        <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
          {phase === "creating" ? "Creating your team's memory repo…" : "Cloning team memory…"}
        </h1>
        <p className="mt-3 flex items-center gap-2 text-sm text-stone-700 dark:text-stone-300">
          <Loader2 size={14} className="animate-spin" />
          This takes about 10 seconds.
        </p>
      </FullPage>
    );
  }

  if (phase === "invite" && inviteUri) {
    return <InviteLinkModal uri={inviteUri} onDone={finishInvite} />;
  }

  if (phase === "error" && error) {
    return (
      <FullPage>
        <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
          Something went wrong
        </h1>
        <p className="mt-3 flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400">
          <AlertCircle size={14} /> {error}
        </p>
        <div className="mt-6 flex gap-3">
          <Button onClick={() => setPhase("pick")}>Try again</Button>
          <Button variant="outline" onClick={chooseSolo}>
            Stay solo for now
          </Button>
        </div>
      </FullPage>
    );
  }

  return (
    <FullPage>
      <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
        Where will your team's memory live?
      </h1>
      <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
        Tangerine stores meetings, decisions, and AI context as markdown files
        your team can share via git.
      </p>

      <div className="mt-6 space-y-3">
        <ChoiceCard
          selected={mode === "create"}
          onSelect={() => setMode("create")}
          icon={<Github size={16} />}
          title="Create new GitHub repo"
          recommended
          body="Tangerine creates a private repo, adds a starter folder, and gives you an invite link for your team. About 10 seconds."
        />
        <ChoiceCard
          selected={mode === "existing"}
          onSelect={() => setMode("existing")}
          icon={<FolderOpen size={16} />}
          title="Use existing GitHub repo"
          body="Paste a clone URL. Useful when your team already has a memory repo from another machine."
        >
          {mode === "existing" && (
            <div className="mt-3 space-y-2">
              <Label htmlFor="existing-url" className="text-[11px]">Clone URL</Label>
              <Input
                id="existing-url"
                placeholder="https://github.com/your-team/tangerine-memory.git"
                value={existingUrl}
                onChange={(e) => setExistingUrl(e.target.value)}
              />
            </div>
          )}
        </ChoiceCard>
        <ChoiceCard
          selected={mode === "solo"}
          onSelect={() => setMode("solo")}
          icon={<FolderOpen size={16} />}
          title="Solo / local only"
          body="Memory stays in ~/.tangerine-memory. Switch to team mode any time."
        />
      </div>

      <div className="mt-8 flex justify-end">
        <Button
          onClick={() => {
            if (mode === "create") void chooseCreateNew();
            else if (mode === "existing") void chooseExisting();
            else chooseSolo();
          }}
        >
          Continue <ArrowRight size={14} />
        </Button>
      </div>
    </FullPage>
  );
}

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-[var(--ti-paper-100)] dark:bg-stone-950">
      <div className="flex w-full max-w-xl flex-col justify-center p-8">{children}</div>
    </div>
  );
}

function ChoiceCard({
  selected,
  onSelect,
  icon,
  title,
  body,
  recommended,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  body: string;
  recommended?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full rounded-md border p-4 text-left transition-colors ${
        selected
          ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] dark:bg-stone-900"
          : "border-stone-200 bg-stone-50 hover:bg-stone-100 dark:border-stone-800 dark:bg-stone-950 dark:hover:bg-stone-900"
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-stone-700 dark:text-stone-300">{icon}</span>
        <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{title}</span>
        {recommended && (
          <span className="ml-auto rounded border border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-50)] px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]">
            Recommended
          </span>
        )}
      </div>
      <p className="mt-1 pl-6 text-[11px] text-stone-600 dark:text-stone-400">{body}</p>
      {children && <div className="pl-6">{children}</div>}
    </button>
  );
}

/** Best-effort guess at a clean local clone dir. */
function deriveLocalClonePath(memoryRoot: string, repoName: string): string {
  // memoryRoot is typically `<home>/.tangerine-memory`. We want a sibling
  // dir under <home>/Documents/Tangerine/<repo-name>.
  const home = memoryRoot.replace(/[\\/]\.?tangerine-memory.*$/, "");
  const sep = memoryRoot.includes("\\") ? "\\" : "/";
  return `${home}${sep}Documents${sep}Tangerine${sep}${repoName}`;
}

function inferRepoName(url: string): string {
  // Accept https://github.com/x/y(.git) and git@github.com:x/y(.git).
  const m = url.match(/[/:]([\w.-]+?)(?:\.git)?\/?\s*$/);
  return m ? m[1] : "team-memory";
}

function humanize(e: unknown): string {
  if (!e) return "Unknown error.";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  // Tauri AppError lands here as { kind, code, detail }.
  const obj = e as { detail?: string; message?: string; code?: string };
  return obj.detail ?? obj.message ?? obj.code ?? JSON.stringify(e);
}
