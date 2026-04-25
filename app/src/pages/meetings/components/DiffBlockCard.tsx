/**
 * DiffBlockCard — center column of RV-0. One diff block at a time, syntax-
 * highlighted body, transcript-ref pills, edit-in-place textarea.
 *
 * Tradeoff: textarea instead of Monaco. Monaco bloats the bundle (~2 MB) and
 * we don't need IntelliSense for ~20 lines of diff. Plain textarea + monospace
 * is faster, lighter, easier to test. Flagged for DZ in the report.
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import type { DiffBlockJson } from "@/lib/tauri";

interface Props {
  block: DiffBlockJson;
  /** Index/total for the progress label. */
  index: number;
  total: number;
  /** Effective body (may differ from block.body if user edited it locally). */
  effectiveBody: string;
  isEditing: boolean;
  onApprove: () => void;
  onReject: () => void;
  onEdit: () => void;
  onSkip: () => void;
  onSaveEdit: (body: string) => void;
  onCancelEdit: () => void;
  onTranscriptRef?: (ref: string) => void;
}

const ACTION_COLOR: Record<DiffBlockJson["action"], string> = {
  append: "#5B21B6",
  insert: "#1E40AF",
  replace: "#B8860B",
  create: "#065F46",
};

export function DiffBlockCard({
  block,
  index,
  total,
  effectiveBody,
  isEditing,
  onApprove,
  onReject,
  onEdit,
  onSkip,
  onSaveEdit,
  onCancelEdit,
  onTranscriptRef,
}: Props) {
  const [draft, setDraft] = useState(effectiveBody);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(effectiveBody);
  }, [effectiveBody, block.id]);

  useEffect(() => {
    if (isEditing) taRef.current?.focus();
  }, [isEditing]);

  return (
    <article
      className="flex h-full flex-col gap-4 overflow-auto"
      data-testid={`diff-block-${block.id}`}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--ti-border-faint)] pb-3">
        <span className="text-xs text-[var(--ti-ink-500)]">
          Block {index + 1} of {total}
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-xs font-medium"
          style={{
            background: ACTION_COLOR[block.action] + "22",
            color: ACTION_COLOR[block.action],
          }}
        >
          {block.action}
        </span>
        <code className="font-mono text-sm text-[var(--ti-ink-900)]">{block.target_file}</code>
        {block.insert_anchor && (
          <span className="text-xs text-[var(--ti-ink-500)]">
            anchor: <code className="font-mono">{block.insert_anchor}</code>
          </span>
        )}
        <StatusBadge status={block.status} />
      </header>

      <div className="flex flex-col gap-2">
        <div>
          <span className="ti-section-label">Reason</span>
          <p className="mt-1 text-sm text-[var(--ti-ink-700)]">{block.reason}</p>
        </div>
        {block.transcript_refs.length > 0 && (
          <div>
            <span className="ti-section-label">Transcript refs</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {block.transcript_refs.map((r) => (
                <button
                  key={r}
                  onClick={() => onTranscriptRef?.(r)}
                  data-testid={`ref-${r}`}
                  className="rounded-full bg-[var(--ti-paper-200)] px-2.5 py-0.5 text-xs font-mono text-[var(--ti-ink-700)] hover:bg-[var(--ti-orange-50)] hover:text-[var(--ti-orange-700)]"
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col">
        <span className="ti-section-label mb-1">Body</span>
        {isEditing ? (
          <>
            <textarea
              ref={taRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              data-testid="diff-edit-textarea"
              className="min-h-[200px] flex-1 rounded-md border border-[var(--ti-orange-500)] bg-[var(--ti-paper-50)] p-3 font-mono text-xs leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-2 flex justify-end gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={onCancelEdit}
                data-testid="diff-edit-cancel"
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => onSaveEdit(draft)}
                data-testid="diff-edit-save"
              >
                Save
              </Button>
            </div>
          </>
        ) : (
          <DiffSyntax body={effectiveBody} />
        )}
      </div>

      {!isEditing && (
        <footer className="flex items-center gap-2 border-t border-[var(--ti-border-faint)] pt-3">
          <Button onClick={onApprove} size="sm" data-testid="diff-approve">
            Approve
            <span className="ml-1 text-[10px] opacity-70">A</span>
          </Button>
          <Button onClick={onReject} size="sm" variant="destructive" data-testid="diff-reject">
            Reject
            <span className="ml-1 text-[10px] opacity-70">R</span>
          </Button>
          <Button onClick={onEdit} size="sm" variant="outline" data-testid="diff-edit">
            Edit
            <span className="ml-1 text-[10px] opacity-70">E</span>
          </Button>
          <Button onClick={onSkip} size="sm" variant="ghost" data-testid="diff-skip">
            Skip
            <span className="ml-1 text-[10px] opacity-70">S</span>
          </Button>
          <span className="ml-auto text-[10px] text-[var(--ti-ink-500)]">
            ↑↓ navigate · J/K vim · ←→ collapse list
          </span>
        </footer>
      )}
    </article>
  );
}

function DiffSyntax({ body }: { body: string }) {
  return (
    <pre
      className="flex-1 overflow-auto rounded-md bg-[var(--ti-paper-100)] p-3 font-mono text-xs leading-relaxed"
      data-testid="diff-body"
    >
      {body.split("\n").map((line, i) => {
        let cls = "text-[var(--ti-ink-700)]";
        if (line.startsWith("+")) cls = "text-[#065F46]";
        else if (line.startsWith("-")) cls = "text-[#991B1B]";
        return (
          <span key={i} className={"block " + cls}>
            {line || "\u00A0"}
          </span>
        );
      })}
    </pre>
  );
}

function StatusBadge({ status }: { status: DiffBlockJson["status"] }) {
  const map: Record<DiffBlockJson["status"], { bg: string; fg: string; label: string }> = {
    pending: { bg: "#E7E5E4", fg: "#44403C", label: "pending" },
    approved: { bg: "#D1FAE5", fg: "#065F46", label: "approved" },
    rejected: { bg: "#FEE2E2", fg: "#991B1B", label: "rejected" },
    edited: { bg: "#FFE8D6", fg: "#A03F00", label: "edited" },
  };
  const c = map[status];
  return (
    <span
      data-testid={`block-status-${status}`}
      className="rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ background: c.bg, color: c.fg }}
    >
      {c.label}
    </span>
  );
}
