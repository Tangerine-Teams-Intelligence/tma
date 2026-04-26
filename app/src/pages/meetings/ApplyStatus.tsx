/**
 * AP-0 Apply status. Shows steps + commit_sha after merge.
 */
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Check, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { openExternal } from "@/lib/tauri";

const STEPS = [
  "Validating target repo",
  "Writing files",
  "Staging",
  "Committing",
];

export default function ApplyStatus() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const commit = params.get("commit");
  const written = params.get("written");

  return (
    <div className="mx-auto max-w-xl p-8" data-testid="ap-0">
      <Card className="p-6">
        <div className="flex items-center gap-3">
          <div className="rounded-full bg-[#D1FAE5] p-2">
            <Check size={20} color="#065F46" />
          </div>
          <div>
            <h1 className="font-display text-2xl">Applied.</h1>
            <p className="text-sm text-[var(--ti-ink-500)]">
              {written ?? 0} file{written === "1" ? "" : "s"} written, commit{" "}
              <code className="font-mono">{commit ?? "(pending)"}</code>.
            </p>
          </div>
        </div>

        <ol className="mt-6 flex flex-col gap-2">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2 text-sm">
              <Check size={14} color="#065F46" />
              <span className="text-[var(--ti-ink-700)]">
                {i + 1}. {s}
              </span>
            </li>
          ))}
        </ol>

        <div className="mt-6 rounded-md bg-[var(--ti-paper-100)] p-3 text-xs text-[var(--ti-ink-700)]">
          Run <code className="font-mono">git push</code> from the target repo to publish.
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={() => nav(`/meetings/${id}`)}>Back to meeting</Button>
          <Button variant="outline" onClick={() => void openExternal("file://")}>
            <ExternalLink size={14} />
            Open in editor
          </Button>
        </div>
      </Card>
    </div>
  );
}
