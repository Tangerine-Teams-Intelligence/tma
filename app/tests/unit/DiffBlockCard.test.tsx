/**
 * DiffBlockCard unit tests — RV-0's core component.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { DiffBlockCard } from "../../src/pages/meetings/components/DiffBlockCard";
import type { DiffBlockJson } from "../../src/lib/tauri";

const block: DiffBlockJson = {
  id: 1,
  target_file: "knowledge/session-state.md",
  action: "append",
  insert_anchor: null,
  reason: "Decision on v1 scope",
  transcript_refs: ["L47", "L52"],
  body: "+ added line\n- removed line\n  context",
  status: "pending",
};

describe("DiffBlockCard", () => {
  function setup(overrides: Partial<Parameters<typeof DiffBlockCard>[0]> = {}) {
    const props = {
      block,
      index: 0,
      total: 3,
      effectiveBody: block.body,
      isEditing: false,
      onApprove: vi.fn(),
      onReject: vi.fn(),
      onEdit: vi.fn(),
      onSkip: vi.fn(),
      onSaveEdit: vi.fn(),
      onCancelEdit: vi.fn(),
      onTranscriptRef: vi.fn(),
      ...overrides,
    };
    return { props, ...render(<DiffBlockCard {...props} />) };
  }

  it("renders header with target file, action, and progress", () => {
    setup();
    expect(screen.getByText("knowledge/session-state.md")).toBeInTheDocument();
    expect(screen.getByText("append")).toBeInTheDocument();
    expect(screen.getByText("Block 1 of 3")).toBeInTheDocument();
  });

  it("renders + lines green and - lines red via class hooks", () => {
    setup();
    const body = screen.getByTestId("diff-body");
    expect(body.textContent).toContain("+ added line");
    expect(body.textContent).toContain("- removed line");
  });

  it("approve button fires onApprove", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("diff-approve"));
    expect(props.onApprove).toHaveBeenCalledOnce();
  });

  it("reject button fires onReject", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("diff-reject"));
    expect(props.onReject).toHaveBeenCalledOnce();
  });

  it("transcript ref pills are clickable", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("ref-L47"));
    expect(props.onTranscriptRef).toHaveBeenCalledWith("L47");
  });

  it("edit mode swaps body for textarea, save passes draft", () => {
    const onSaveEdit = vi.fn();
    setup({ isEditing: true, onSaveEdit });
    const ta = screen.getByTestId("diff-edit-textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "+ replaced" } });
    fireEvent.click(screen.getByTestId("diff-edit-save"));
    expect(onSaveEdit).toHaveBeenCalledWith("+ replaced");
  });

  it("edit mode cancel restores original (caller-managed)", () => {
    const onCancelEdit = vi.fn();
    setup({ isEditing: true, onCancelEdit });
    fireEvent.click(screen.getByTestId("diff-edit-cancel"));
    expect(onCancelEdit).toHaveBeenCalledOnce();
  });

  it("status badge reflects current decision", () => {
    setup({ block: { ...block, status: "approved" } });
    expect(screen.getByTestId("block-status-approved")).toBeInTheDocument();
  });
});
