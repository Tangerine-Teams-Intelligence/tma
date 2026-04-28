import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";

/**
 * Shown after the champion finishes "create new repo". Surfaces the
 * `tangerine://join?...` invite URL with a one-click copy button + a
 * "Send via Slack/email" copy hint.
 */
export function InviteLinkModal({
  uri,
  onDone,
}: {
  uri: string;
  onDone: () => void;
}) {
  const pushToast = useStore((s) => s.ui.pushToast);
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      pushToast("success", "Invite link copied. Paste it into Slack or email.");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      pushToast("error", "Couldn't copy. Select the link manually below.");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-[var(--ti-paper-100)] dark:bg-stone-950"
      // === v1.14.0 round-1 === — testid for the cold-start E2E test so
      // the funnel suite can assert the modal mounted with the right URI.
      data-testid="invite-link-modal"
      // === end v1.14.0 round-1 ===
    >
      <div className="flex w-full max-w-xl flex-col justify-center p-8">
        <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
          Your team's memory is live
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Send your team this link. When they click it, Tangerine pulls their
          copy of the memory automatically.
        </p>
        <div className="mt-6 rounded-md border border-stone-300 bg-stone-100 px-4 py-3 dark:border-stone-700 dark:bg-stone-900">
          <p
            className="break-all font-mono text-[11px] text-stone-700 dark:text-stone-300"
            // === v1.14.0 round-1 === — pin the URI element so the funnel
            // test can verify the user can paste it manually if the
            // clipboard write fails (Wayland / locked-down kiosk modes).
            data-testid="invite-link-uri"
            // === end v1.14.0 round-1 ===
          >
            {uri}
          </p>
        </div>
        <div className="mt-4 flex gap-3">
          <Button
            onClick={copy}
            // === v1.14.0 round-1 ===
            data-testid="invite-link-copy"
            // === end v1.14.0 round-1 ===
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy invite"}
          </Button>
          <Button
            variant="outline"
            onClick={onDone}
            // === v1.14.0 round-1 ===
            data-testid="invite-link-done"
            // === end v1.14.0 round-1 ===
          >
            Done
          </Button>
        </div>
        <p className="mt-6 text-[11px] text-stone-500 dark:text-stone-400">
          Link expires in 7 days. You can generate a new one any time from
          Settings → Team memory.
        </p>
      </div>
    </div>
  );
}
