// === wave 1.13-C ===
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  AIExtractedMentionCard,
  type AIExtractedMentionEvent,
} from "../src/components/inbox/AIExtractedMentionCard";

function makeEvent(overrides: Partial<AIExtractedMentionEvent> = {}): AIExtractedMentionEvent {
  return {
    id: "aim-test-1",
    kind: "ai_extracted_mention",
    targetUser: "hongyu",
    sourceUser: "daizhe",
    sourceAtom: "personal/daizhe/threads/cursor/abc123.md",
    timestamp: "2026-04-27T10:00:00Z",
    payload: {
      intent: "ask",
      snippet: "I should ask Hongyu about the PCB supplier choice tomorrow.",
      confidence: 0.9,
      vendor: "cursor",
      extractor: "heuristic",
    },
    read: false,
    archived: false,
    ...overrides,
  };
}

describe("AIExtractedMentionCard", () => {
  it("renders the Tangerine emoji badge + snippet for an AI-extracted mention", () => {
    render(<AIExtractedMentionCard event={makeEvent()} />);
    // Badge is the unique-to-Tangerine surface signal.
    const badge = screen.getByTestId("ai-extracted-badge");
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain("🍊");
    // Snippet must be rendered verbatim, italicized via CSS class.
    const snippet = screen.getByTestId("ai-extracted-snippet");
    expect(snippet).toBeInTheDocument();
    expect(snippet.textContent).toContain("ask Hongyu about the PCB");
    expect(snippet.className).toContain("italic");
  });

  it("renders the source-atom path + vendor color dot", () => {
    render(<AIExtractedMentionCard event={makeEvent()} />);
    const link = screen.getByTestId("ai-extracted-source-link");
    expect(link).toBeInTheDocument();
    expect(link.textContent).toBe("personal/daizhe/threads/cursor/abc123.md");
    const dot = screen.getByTestId("ai-extracted-vendor-dot");
    expect(dot).toBeInTheDocument();
    // Cursor's color from the in-component vendor map (#3b82f6).
    const inlineStyle = (dot as HTMLElement).style.backgroundColor;
    // browsers normalise the rgb() form; both spellings accepted.
    expect(
      inlineStyle === "rgb(59, 130, 246)" || inlineStyle.toLowerCase().includes("3b82f6"),
    ).toBe(true);
    // Ask intent surfaces the "asked Cursor:" header copy.
    const header = screen.getByTestId("ai-extracted-header");
    expect(header.textContent?.toLowerCase()).toContain("daizhe");
    expect(header.textContent?.toLowerCase()).toContain("cursor");
  });

  it("invokes onOpenAtom + onReplyInChat for the two action buttons", () => {
    const onOpenAtom = vi.fn();
    const onReplyInChat = vi.fn();
    const event = makeEvent();
    render(
      <AIExtractedMentionCard
        event={event}
        onOpenAtom={onOpenAtom}
        onReplyInChat={onReplyInChat}
      />,
    );
    fireEvent.click(screen.getByTestId("ai-extracted-open-atom"));
    expect(onOpenAtom).toHaveBeenCalledWith(event.sourceAtom);
    fireEvent.click(screen.getByTestId("ai-extracted-reply"));
    expect(onReplyInChat).toHaveBeenCalledWith(event);
    // Low-confidence chip should NOT render at conf=0.9.
    expect(screen.queryByTestId("ai-extracted-low-confidence")).toBeNull();
  });
});
// === end wave 1.13-C ===
