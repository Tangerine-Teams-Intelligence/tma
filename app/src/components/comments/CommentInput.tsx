// === wave 1.13-B ===
/**
 * Wave 1.13-B L5 — `<CommentInput/>`. Wraps Wave 1.13-A's
 * `<MentionInput/>` with a Submit button + reset-on-submit behaviour.
 * Emits a single `onSubmit(body)` callback; the parent owns the
 * `comments_create` round-trip so this component stays presentational.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { MessageSquare, Send } from "lucide-react";

import { MentionInput } from "@/components/mention/MentionInput";
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
        <span className="flex items-center gap-1 text-[10px] text-stone-400 dark:text-stone-500">
          <MessageSquare size={10} />
          {t("comments.mentionHint")}
        </span>
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
