// === wave 1.13-B ===
/**
 * Wave 1.13-B L5 — `<CommentInput/>`. Wraps Wave 1.13-A's
 * `<MentionInput/>` with a Submit button + reset-on-submit behaviour.
 * Emits a single `onSubmit(body)` callback; the parent owns the
 * `comments_create` round-trip so this component stays presentational.
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AtSign, MessageSquare, Send } from "lucide-react";

import { MentionInput } from "@/components/mention/MentionInput";
// === v1.13.3 round-3 ===
// Wire the Wave 1.13-A extractMentions helper here so the user gets a
// live "Will notify @alice, @bob" preview before clicking Post. Round 2
// audit found extractMentions was shipped + tested but had zero
// production callers — frontend-side mention firing happens on the Rust
// side after submit, so the helper had no purpose. Showing a preview
// turns it into UX-load-bearing code instead of dead weight.
import { extractMentions } from "@/lib/mention-extract";
// === end v1.13.3 round-3 ===
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CommentInputProps {
  onSubmit: (body: string) => Promise<void> | void;
  placeholder?: string;
  autoFocus?: boolean;
  testId?: string;
  /** Variant: top-of-thread vs reply input. Reply trims the chrome. */
  variant?: "thread" | "reply";
  disabled?: boolean;
}

export function CommentInput({
  onSubmit,
  placeholder,
  autoFocus = false,
  testId = "comment-input",
  variant = "thread",
  disabled = false,
}: CommentInputProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setValue("");
    } finally {
      setBusy(false);
    }
  }, [value, busy, onSubmit]);

  const ph = placeholder ?? t("comments.placeholder");
  const isReply = variant === "reply";

  // === v1.13.3 round-3 ===
  // Live mention preview. extractMentions de-duplicates + skips emails +
  // skips fenced code, so this is the same set the Rust side will fire
  // inbox events for after submit — zero risk of "I see @alice in the
  // hint but the notification went to @aliceemail".
  const mentioned = useMemo(() => extractMentions(value), [value]);
  // === end v1.13.3 round-3 ===

  return (
    <div
      data-testid={testId}
      className={cn(
        "flex flex-col gap-1.5",
        isReply ? "border-t border-stone-200 pt-2 dark:border-stone-800" : "",
      )}
    >
      <MentionInput
        value={value}
        onChange={setValue}
        onSubmit={() => void submit()}
        placeholder={ph}
        rows={isReply ? 2 : 3}
        ariaLabel={ph}
        testId={`${testId}-textarea`}
        disabled={disabled || busy}
      />
      <div className="flex items-center justify-between">
        {/* === v1.13.3 round-3 ===
            When the body has at least one valid @mention, swap the static
            hint for the live "Will notify" preview so the user sees who's
            about to be paged before they post. AtSign icon distinguishes
            it from the empty-state MessageSquare. */}
        {mentioned.length > 0 ? (
          <span
            data-testid="comment-input-will-notify"
            className="flex items-center gap-1 text-[10px] text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]"
          >
            <AtSign size={10} />
            {t("comments.willNotify", {
              users: mentioned.map((u) => `@${u}`).join(", "),
              defaultValue: `Will notify ${mentioned
                .map((u) => `@${u}`)
                .join(", ")}`,
            })}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-[10px] text-stone-400 dark:text-stone-500">
            <MessageSquare size={10} />
            {t("comments.mentionHint")}
          </span>
        )}
        {/* === end v1.13.3 round-3 === */}
        <Button
          size="sm"
          onClick={() => void submit()}
          disabled={disabled || busy || !value.trim()}
          data-testid={`${testId}-submit`}
        >
          <Send size={12} className="mr-1" />
          {busy ? t("comments.posting") : t("comments.post")}
        </Button>
      </div>
    </div>
  );
}
// === end wave 1.13-B ===
