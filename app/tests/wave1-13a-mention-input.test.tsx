// === wave 1.13-A ===
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useState } from "react";

import { MentionInput } from "../src/components/mention/MentionInput";

const ROSTER = [
  { alias: "alice", displayName: "Alice" },
  { alias: "bob", displayName: "Bob" },
  { alias: "carol", displayName: "Carol" },
];

function Harness({
  initial = "",
  onChange,
}: {
  initial?: string;
  onChange?: (v: string) => void;
}) {
  const [v, setV] = useState(initial);
  return (
    <MentionInput
      value={v}
      onChange={(next) => {
        setV(next);
        onChange?.(next);
      }}
      rosterOverride={ROSTER}
      testId="mention-input"
      ariaLabel="test"
    />
  );
}

describe("MentionInput (wave 1.13-A)", () => {
  it("opens the dropdown when the user types @", () => {
    render(<Harness />);
    const ta = screen.getByTestId("mention-input") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "hey @" } });
    // jsdom doesn't drive selectionEnd off `value` automatically, so we need
    // to set it explicitly.
    ta.selectionEnd = 5;
    fireEvent.change(ta, { target: { value: "hey @" } });
    expect(screen.getByTestId("mention-dropdown")).toBeInTheDocument();
  });

  it("filters suggestions by alias prefix", () => {
    render(<Harness />);
    const ta = screen.getByTestId("mention-input") as HTMLTextAreaElement;
    ta.selectionEnd = 6;
    fireEvent.change(ta, { target: { value: "see @b" } });
    // Only "bob" should appear; alice + carol filtered out.
    expect(screen.getByTestId("mention-option-bob")).toBeInTheDocument();
    expect(screen.queryByTestId("mention-option-alice")).toBeNull();
  });

  it("inserts the alias on Enter", () => {
    let last = "";
    render(<Harness onChange={(v) => (last = v)} />);
    const ta = screen.getByTestId("mention-input") as HTMLTextAreaElement;
    ta.selectionEnd = 1;
    fireEvent.change(ta, { target: { value: "@" } });
    expect(screen.getByTestId("mention-dropdown")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(ta, { key: "Enter" });
    });
    expect(last.startsWith("@alice ")).toBe(true);
  });

  it("Escape closes the dropdown without inserting", () => {
    render(<Harness />);
    const ta = screen.getByTestId("mention-input") as HTMLTextAreaElement;
    ta.selectionEnd = 1;
    fireEvent.change(ta, { target: { value: "@" } });
    expect(screen.getByTestId("mention-dropdown")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(ta, { key: "Escape" });
    });
    expect(screen.queryByTestId("mention-dropdown")).toBeNull();
  });

  it("does NOT open after an alphanumeric char (treats as email)", () => {
    render(<Harness />);
    const ta = screen.getByTestId("mention-input") as HTMLTextAreaElement;
    ta.selectionEnd = 6;
    fireEvent.change(ta, { target: { value: "foo@b" } });
    // f‐o‐o‐@‐b — caret is right after 'b'. The char before '@' is 'o'
    // (alphanumeric) so the input must NOT open.
    expect(screen.queryByTestId("mention-dropdown")).toBeNull();
  });
});
// === end wave 1.13-A ===
