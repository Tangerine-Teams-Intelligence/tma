// === wave 1.13-C ===
/**
 * Wave 1.13-C — presentational card for `ai_extracted_mention` events.
 *
 * Wave 1.13-A's `/inbox` route owns the inbox event list itself (kind
 * dispatch, marking read, archiving, snooze, etc.). This component is
 * what 1.13-A's renderer mounts when an event's `kind ===
 * "ai_extracted_mention"`. We keep the contract narrow:
 *
 *   * Input is the canonical `InboxEvent` shape that lives on disk in
 *     `<memory>/.tangerine/inbox.jsonl` (Wave 1.13-A's `inbox_store`).
 *   * Two callbacks — `onOpenAtom` and `onReplyInChat` — let the parent
 *     wire up navigation + chat compose without this card knowing about
 *     either router or chat surface.
 *
 * The Tangerine emoji badge + italic snippet quote + vendor color dot
 * are spec'd in the Wave 1.13-C plan ("AI-extracted" gets distinct UI
 * treatment in the inbox so users can spot the unique-to-Tangerine
 * surface at a glance).
 */
import { useTranslation } from "react-i18next";

export interface AIExtractedMentionPayload {
  intent?: string;
  snippet?: string;
  confidence?: number;
  vendor?: string;
  extractor?: string;
  [extra: string]: unknown;
}

export interface AIExtractedMentionEvent {
  id: string;
  kind: string;
  targetUser: string;
  sourceUser: string;
  sourceAtom: string;
  timestamp: string;
  payload: AIExtractedMentionPayload;
  read: boolean;
  archived: boolean;
}

export interface AIExtractedMentionCardProps {
  event: AIExtractedMentionEvent;
  onOpenAtom?: (sourceAtom: string) => void;
  onReplyInChat?: (event: AIExtractedMentionEvent) => void;
}

const VENDOR_COLOR: Record<string, string> = {
  cursor: "#3b82f6",
  "claude-code": "#cc5500",
  codex: "#10b981",
  windsurf: "#a855f7",
};

function vendorLabel(vendor: string | undefined, t: ReturnType<typeof useTranslation>["t"]): string {
  switch (vendor) {
    case "cursor":
      return t("inbox.aiExtracted.vendorCursor");
    case "claude-code":
      return t("inbox.aiExtracted.vendorClaudeCode");
    default:
      return vendor ?? "AI";
  }
}

function headerForIntent(
  intent: string | undefined,
  t: ReturnType<typeof useTranslation>["t"],
  vars: { author: string; vendor: string; snippet: string },
): string {
  switch (intent) {
    case "ask":
    case "request":
      return t("inbox.aiExtracted.headerAsk", vars);
    case "tell":
      return t("inbox.aiExtracted.headerTell", vars);
    case "review":
      return t("inbox.aiExtracted.headerReview", vars);
    case "todo":
      return t("inbox.aiExtracted.headerTodo", vars);
    default:
      return t("inbox.aiExtracted.headerMention", vars);
  }
}

export function AIExtractedMentionCard({
  event,
  onOpenAtom,
  onReplyInChat,
}: AIExtractedMentionCardProps) {
  const { t } = useTranslation();
  const intent = event.payload.intent;
  const snippet = event.payload.snippet ?? "";
  const confidence = typeof event.payload.confidence === "number" ? event.payload.confidence : 1;
  const vendor = event.payload.vendor;
  const isLowConf = confidence < 0.7;
  const vendorColor = vendor && vendor in VENDOR_COLOR ? VENDOR_COLOR[vendor] : "#888888";

  const header = headerForIntent(intent, t, {
    author: event.sourceUser,
    vendor: vendorLabel(vendor, t),
    snippet: snippet.length > 60 ? `${snippet.slice(0, 57)}…` : snippet,
  });

  return (
    <div
      data-testid="ai-extracted-mention-card"
      data-event-kind={event.kind}
      className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          data-testid="ai-extracted-badge"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--ti-orange-50)] text-[14px] dark:bg-stone-800"
          title={t("inbox.aiExtracted.badge")}
        >
          🍊
        </span>
        <div className="min-w-0 flex-1">
          <p
            data-testid="ai-extracted-header"
            className="text-[13px] font-medium text-stone-900 dark:text-stone-100"
          >
            {header}
          </p>
          {snippet && (
            <p
              data-testid="ai-extracted-snippet"
              className="mt-2 border-l-2 border-stone-300 pl-3 text-[12px] italic leading-relaxed text-stone-700 dark:border-stone-700 dark:text-stone-300"
            >
              &ldquo;{snippet}&rdquo;
            </p>
          )}
          <div className="mt-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
            <span
              aria-hidden
              data-testid="ai-extracted-vendor-dot"
              style={{ backgroundColor: vendorColor }}
              className="inline-block h-2 w-2 rounded-full"
            />
            <span data-testid="ai-extracted-source-link">{event.sourceAtom}</span>
            {isLowConf && (
              <span
                data-testid="ai-extracted-low-confidence"
                className="ml-2 normal-case tracking-normal text-stone-500"
              >
                · {t("inbox.aiExtracted.lowConfidence")}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          data-testid="ai-extracted-open-atom"
          onClick={() => onOpenAtom?.(event.sourceAtom)}
          className="rounded border border-stone-200 px-2 py-0.5 font-mono text-[11px] text-stone-600 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          {t("inbox.aiExtracted.openAtom")}
        </button>
        <button
          type="button"
          data-testid="ai-extracted-reply"
          onClick={() => onReplyInChat?.(event)}
          className="rounded bg-[var(--ti-orange-500)] px-2 py-0.5 font-mono text-[11px] text-white hover:bg-[var(--ti-orange-600)]"
        >
          {t("inbox.aiExtracted.replyInChat")}
        </button>
      </div>
    </div>
  );
}
// === end wave 1.13-C ===
