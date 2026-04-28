// === wave 1.13-B ===
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

import "../src/i18n/index";

vi.mock("../src/components/mention/MentionInput", () => ({
  MentionInput: ({
    value,
    onChange,
    testId,
  }: {
    value: string;
    onChange: (v: string) => void;
    testId?: string;
  }) => (
    <textarea
      data-testid={testId}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { CommentInput } from "../src/components/comments/CommentInput";

describe("CommentInput (wave 1.13-B)", () => {
  it("disables submit when body is empty", () => {
    render(<CommentInput onSubmit={vi.fn()} />);
    const submit = screen.getByTestId("comment-input-submit");
    expect(submit).toBeDisabled();
  });

  it("calls onSubmit with trimmed body and resets", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<CommentInput onSubmit={onSubmit} />);
    const ta = screen.getByTestId("comment-input-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "  hey @sam look at this  " } });
    const submit = screen.getByTestId("comment-input-submit");
    fireEvent.click(submit);
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("hey @sam look at this");
    });
    // textarea should be cleared after submit
    await waitFor(() => {
      expect((screen.getByTestId("comment-input-textarea") as HTMLTextAreaElement).value).toBe("");
    });
  });
});
// === end wave 1.13-B ===
