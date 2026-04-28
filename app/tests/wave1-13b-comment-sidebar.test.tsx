// === wave 1.13-B ===
import { describe, expect, it, vi, beforeEach } from "vitest";
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

vi.mock("../src/lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../src/lib/tauri",
  );
  let store: unknown[] = [];
  return {
    ...actual,
    commentsList: vi.fn(async () => store),
    commentsCreate: vi.fn(
      async (
        atomPath: string,
        anchor: { paragraph_index: number },
        body: string,
        author: string,
        parentId?: string,
      ) => {
        const id = `c_${store.length + 1}`;
        const tid = parentId ?? `th_${store.length + 1}`;
        const c = {
          id,
          thread_id: tid,
          atom_path: atomPath,
          anchor: { ...anchor, char_offset_start: 0, char_offset_end: 0 },
          author,
          body,
          created_at: new Date().toISOString(),
          parent_id: parentId ?? null,
          resolved: false,
        };
        const existing = store.find(
          (s: unknown) => (s as { thread_id: string }).thread_id === tid,
        ) as { comments: unknown[] } | undefined;
        if (existing) {
          existing.comments.push(c);
        } else {
          store.push({
            thread_id: tid,
            atom_path: atomPath,
            anchor: c.anchor,
            comments: [c],
            resolved: false,
          });
        }
        return c;
      },
    ),
    commentsResolve: vi.fn(async () => undefined),
    commentsUnresolve: vi.fn(async () => undefined),
    commentsArchive: vi.fn(async () => undefined),
    __reset: () => {
      store = [];
    },
  };
});

import { CommentSidebar } from "../src/components/comments/CommentSidebar";

describe("CommentSidebar (wave 1.13-B)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the new-thread input when open", async () => {
    render(
      <CommentSidebar
        atomPath="team/decisions/x.md"
        currentUser="alex"
        open={true}
        onClose={vi.fn()}
        activeParagraph={2}
      />,
    );
    expect(await screen.findByTestId("comment-sidebar-new")).toBeInTheDocument();
    expect(screen.getByText(/New thread on paragraph 3/)).toBeInTheDocument();
  });

  it("creates a thread on submit and shows it in the list", async () => {
    render(
      <CommentSidebar
        atomPath="team/decisions/y.md"
        currentUser="alex"
        open={true}
        onClose={vi.fn()}
      />,
    );
    const ta = (await screen.findByTestId(
      "comment-sidebar-new-textarea",
    )) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "great point" } });
    const submit = screen.getByTestId("comment-sidebar-new-submit");
    fireEvent.click(submit);
    await waitFor(() => {
      expect(screen.queryByText(/great point/)).toBeInTheDocument();
    });
  });

  it("returns null when open=false", () => {
    const { container } = render(
      <CommentSidebar
        atomPath="team/decisions/z.md"
        currentUser="alex"
        open={false}
        onClose={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-testid='comment-sidebar']")).toBeNull();
  });
});
// === end wave 1.13-B ===
