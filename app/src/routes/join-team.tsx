import { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { gitClone, parseInvite, syncStart } from "@/lib/git";
import { ghDeviceFlowStart, ghDeviceFlowPollUntilReady } from "@/lib/github";
import { openExternal, resolveMemoryRoot } from "@/lib/tauri";

type Phase = "validating" | "accept" | "auth" | "polling" | "cloning" | "done" | "error";

/**
 * Landing page for the `tangerine://join?repo=<url>&token=<token>` deep link.
 *
 *   1. Parse the invite (validate + un-tamper the token).
 *   2. "Daizhe invited you" panel — user clicks Accept.
 *   3. Device-flow OAuth so we have a token to clone with.
 *   4. Clone the repo to ~/Documents/Tangerine/<repo-name>.
 *   5. Wire memoryConfig + start the sync ticker. /memory takes over.
 *
 * Deep-link wiring: App.tsx subscribes to the `deeplink://join` event and
 * navigates here with the URI in `?uri=`.
 */
export default function JoinTeamRoute() {
  const navigate = useNavigate();
  const setMemoryConfig = useStore((s) => s.ui.setMemoryConfig);
  const setMemoryRoot = useStore((s) => s.ui.setMemoryRoot);
  const pushToast = useStore((s) => s.ui.pushToast);
  const [params] = useSearchParams();
  const [phase, setPhase] = useState<Phase>("validating");
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<{ user_code: string; verification_uri: string } | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      const uri = params.get("uri");
      if (!uri) {
        if (cancel) return;
        setError("No invite URL provided.");
        setPhase("error");
        return;
      }
      const r = await parseInvite({ uri });
      if (cancel) return;
      if (!r.valid || !r.repo_url) {
        setError(r.reason ?? "This invite link is invalid.");
        setPhase("error");
        return;
      }
      setRepoUrl(r.repo_url);
      setPhase("accept");
    })();
    return () => {
      cancel = true;
    };
  }, [params]);

  async function accept() {
    if (!repoUrl) return;
    setError(null);
    setPhase("auth");
    try {
      const start = await ghDeviceFlowStart();
      setDevice({ user_code: start.user_code, verification_uri: start.verification_uri });
      void openExternal(start.verification_uri);
      setPhase("polling");
      const login = await ghDeviceFlowPollUntilReady(start);
      setPhase("cloning");
      const root = await resolveMemoryRoot();
      const repoName = inferRepoName(repoUrl);
      const localClone = deriveLocalClonePath(root.path, repoName);
      await gitClone({ url: repoUrl, dest: localClone });
      setMemoryConfig({
        mode: "team",
        repoUrl,
        repoLocalPath: localClone,
        githubLogin: login,
      });
      setMemoryRoot(`${localClone}/memory`);
      void syncStart({ repoPath: localClone, login });
      pushToast("success", "You're in. Team memory loaded.");
      setPhase("done");
      navigate("/memory", { replace: true });
    } catch (e) {
      setError(humanize(e));
      setPhase("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-[var(--ti-paper-100)] dark:bg-stone-950">
      <div className="flex w-full max-w-xl flex-col justify-center p-8">
        {phase === "validating" && (
          <p className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
            <Loader2 size={14} className="animate-spin" /> Validating invite…
          </p>
        )}
        {phase === "accept" && repoUrl && (
          <>
            <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
              Join your team's memory
            </h1>
            <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
              Tangerine will clone this repo to{" "}
              <span className="font-mono text-[12px]">~/Documents/Tangerine/</span> and
              keep it in sync with your team.
            </p>
            <p className="mt-4 break-all rounded-md border border-stone-200 bg-stone-50 px-3 py-2 font-mono text-[11px] text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400">
              {repoUrl}
            </p>
            <div className="mt-6 flex gap-3">
              <Button onClick={accept}>Accept</Button>
              <Button variant="outline" onClick={() => navigate("/memory", { replace: true })}>
                Decline
              </Button>
            </div>
          </>
        )}
        {(phase === "auth" || phase === "polling") && (
          <>
            <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
              Sign in to GitHub
            </h1>
            <p className="mt-3 text-sm text-stone-700 dark:text-stone-300">
              Type this code on the GitHub page we just opened:
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
          </>
        )}
        {phase === "cloning" && (
          <p className="flex items-center gap-2 text-sm text-stone-600 dark:text-stone-400">
            <Loader2 size={14} className="animate-spin" /> Cloning team memory…
          </p>
        )}
        {phase === "error" && error && (
          <>
            <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
              Something went wrong
            </h1>
            <p className="mt-3 flex items-center gap-2 text-sm text-rose-600 dark:text-rose-400">
              <AlertCircle size={14} /> {error}
            </p>
            <div className="mt-6 flex gap-3">
              <Button onClick={() => navigate("/memory", { replace: true })}>
                Back to memory
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function deriveLocalClonePath(memoryRoot: string, repoName: string): string {
  const home = memoryRoot.replace(/[\\/]\.?tangerine-memory.*$/, "");
  const sep = memoryRoot.includes("\\") ? "\\" : "/";
  return `${home}${sep}Documents${sep}Tangerine${sep}${repoName}`;
}

function inferRepoName(url: string): string {
  const m = url.match(/[/:]([\w.-]+?)(?:\.git)?\/?\s*$/);
  return m ? m[1] : "team-memory";
}

function humanize(e: unknown): string {
  if (!e) return "Unknown error.";
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  const obj = e as { detail?: string; message?: string; code?: string };
  return obj.detail ?? obj.message ?? obj.code ?? JSON.stringify(e);
}
