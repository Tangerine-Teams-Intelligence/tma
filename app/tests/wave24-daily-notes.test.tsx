// === wave 24 ===
/**
 * Wave 24 — daily notes route + template menu tests.
 *
 * Coverage:
 *   1. /daily renders today's note (mock returns body, route renders editor).
 *   2. Date picker + prev/next buttons navigate between days.
 *   3. Calendar heatmap shows recent dates with the `data-has-note=true` flag.
 *   4. Apply template dropdown lists templates from the bundle.
 *
 * The route lives at `app/src/routes/daily.tsx`; we hoist mocks for the
 * 4 Tauri command wrappers (`dailyNotesRead`, `dailyNotesEnsureToday`,
 * `dailyNotesList`, `templatesList`) so the deterministic empty-state
 * paths exercise the same components Tauri would.
 */

import {
  describe,
  expect,
  it,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

// Hoisted mocks for the 4 daily-note Tauri wrappers. The route also calls
// `templatesApply` + `dailyNotesSave` but only on user interaction — the
// happy-path tests below never click those.
const tauriMocks = vi.hoisted(() => {
  return {
    dailyNotesEnsureToday: vi.fn(),
    dailyNotesRead: vi.fn(),
    dailyNotesList: vi.fn(),
    dailyNotesSave: vi.fn(),
    templatesList: vi.fn(),
    templatesApply: vi.fn(),
  };
});

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    dailyNotesEnsureToday: tauriMocks.dailyNotesEnsureToday,
    dailyNotesRead: tauriMocks.dailyNotesRead,
    dailyNotesList: tauriMocks.dailyNotesList,
    dailyNotesSave: tauriMocks.dailyNotesSave,
    templatesList: tauriMocks.templatesList,
    templatesApply: tauriMocks.templatesApply,
  };
});

import DailyRoute from "../src/routes/daily";
import { localTodayIso } from "../src/lib/tauri";

const TODAY = localTodayIso();
function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}
const YESTERDAY = addDaysIso(TODAY, -1);

const TODAY_BODY = `---
date: ${TODAY}
kind: daily
author: me
---

# Daily — today

## What the team decided today
(co-thinker fills in via heartbeat)

## What I worked on
- testing wave 24

## Decisions to make tomorrow
- (your notes here)

## Insights from AI tools today
(co-thinker fills in citing recent atoms)
`;

const YESTERDAY_BODY = `---
date: ${YESTERDAY}
kind: daily
author: me
---

# Daily — yesterday

## What I worked on
- shipped wave 23
`;

beforeEach(() => {
  vi.restoreAllMocks();
  tauriMocks.dailyNotesEnsureToday.mockReset();
  tauriMocks.dailyNotesRead.mockReset();
  tauriMocks.dailyNotesList.mockReset();
  tauriMocks.dailyNotesSave.mockReset();
  tauriMocks.templatesList.mockReset();
  tauriMocks.templatesApply.mockReset();

  tauriMocks.dailyNotesEnsureToday.mockResolvedValue({
    path: `~/.tangerine-memory/team/daily/${TODAY}.md`,
    created: false,
    date: TODAY,
  });
  tauriMocks.dailyNotesRead.mockImplementation(async (date: string) => {
    if (date === TODAY) return TODAY_BODY;
    if (date === YESTERDAY) return YESTERDAY_BODY;
    return "";
  });
  tauriMocks.dailyNotesList.mockResolvedValue([
    {
      date: TODAY,
      path: `~/.tangerine-memory/team/daily/${TODAY}.md`,
      rel_path: `team/daily/${TODAY}.md`,
      bytes: 200,
    },
    {
      date: YESTERDAY,
      path: `~/.tangerine-memory/team/daily/${YESTERDAY}.md`,
      rel_path: `team/daily/${YESTERDAY}.md`,
      bytes: 100,
    },
  ]);
  tauriMocks.templatesList.mockResolvedValue([
    {
      id: "decision",
      label: "Decision",
      kind: "decision",
      vertical: null,
      bytes: 400,
    },
    {
      id: "weekly-review",
      label: "Weekly review (Friday retro)",
      kind: "review",
      vertical: null,
      bytes: 500,
    },
    {
      id: "pcb-supplier-eval",
      label: "PCB supplier evaluation",
      kind: "evaluation",
      vertical: "pcb",
      bytes: 600,
    },
  ]);
  tauriMocks.templatesApply.mockResolvedValue({
    path: "/path/to/atom.md",
    rel_path: "team/decisions/decision-x.md",
    copied: true,
  });
  tauriMocks.dailyNotesSave.mockResolvedValue({
    path: `~/.tangerine-memory/team/daily/${TODAY}.md`,
    created: false,
    date: TODAY,
  });
});

afterEach(() => {
  cleanup();
});

function renderRoute(initialPath: string = "/daily") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/daily" element={<DailyRoute />} />
        <Route path="/memory/*" element={<div data-testid="memory-route" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Wave 24 — /daily route renders today's note", () => {
  it("ensures + reads + renders today's body", async () => {
    renderRoute();
    await waitFor(() => {
      expect(tauriMocks.dailyNotesEnsureToday).toHaveBeenCalled();
      expect(tauriMocks.dailyNotesRead).toHaveBeenCalledWith(TODAY);
    });
    const editor = await screen.findByTestId("daily-editor");
    expect((editor as HTMLTextAreaElement).value).toContain(
      "# Daily — today",
    );
    expect((editor as HTMLTextAreaElement).value).toContain(
      "## What the team decided today",
    );
  });
});

describe("Wave 24 — date picker navigates prev/next day", () => {
  it("prev button loads yesterday and re-fetches", async () => {
    renderRoute();
    await waitFor(() =>
      expect(tauriMocks.dailyNotesRead).toHaveBeenCalledWith(TODAY),
    );
    fireEvent.click(screen.getByTestId("daily-prev"));
    await waitFor(() => {
      expect(tauriMocks.dailyNotesRead).toHaveBeenCalledWith(YESTERDAY);
    });
    const editor = (await screen.findByTestId(
      "daily-editor",
    )) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(editor.value).toContain("# Daily — yesterday");
    });
  });

  it("date picker change loads the picked day", async () => {
    renderRoute();
    await waitFor(() =>
      expect(tauriMocks.dailyNotesRead).toHaveBeenCalledWith(TODAY),
    );
    const picker = screen.getByTestId(
      "daily-date-picker",
    ) as HTMLInputElement;
    fireEvent.change(picker, { target: { value: YESTERDAY } });
    await waitFor(() => {
      expect(tauriMocks.dailyNotesRead).toHaveBeenCalledWith(YESTERDAY);
    });
  });
});

describe("Wave 24 — calendar heatmap shows recent dates", () => {
  it("renders 30 cells, today + yesterday have data-has-note=true", async () => {
    renderRoute();
    await screen.findByTestId("daily-heatmap");
    const cells = await waitFor(() => {
      const todayCell = screen.getByTestId(`daily-heatmap-cell-${TODAY}`);
      const yesterdayCell = screen.getByTestId(
        `daily-heatmap-cell-${YESTERDAY}`,
      );
      return { todayCell, yesterdayCell };
    });
    expect(cells.todayCell).toHaveAttribute("data-has-note", "true");
    expect(cells.yesterdayCell).toHaveAttribute("data-has-note", "true");
    // Cells for other dates render with `data-has-note=false`.
    const grid = screen.getByTestId("daily-heatmap");
    expect(grid.querySelectorAll("button").length).toBe(30);
  });
});

describe("Wave 24 — apply-template dropdown", () => {
  it("opens the menu and lists templates from the bundle", async () => {
    renderRoute();
    await waitFor(() => expect(tauriMocks.templatesList).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("daily-template-button"));
    const menu = await screen.findByTestId("daily-template-menu");
    expect(menu).toBeInTheDocument();
    expect(
      screen.getByTestId("daily-template-item-decision"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("daily-template-item-weekly-review"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("daily-template-item-pcb-supplier-eval"),
    ).toBeInTheDocument();
  });

  it("clicking a template fires templates_apply with the chosen id", async () => {
    renderRoute();
    await waitFor(() => expect(tauriMocks.templatesList).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("daily-template-button"));
    const item = await screen.findByTestId(
      "daily-template-item-decision",
    );
    fireEvent.click(item);
    await waitFor(() => {
      expect(tauriMocks.templatesApply).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: "decision" }),
      );
    });
  });
});
// === end wave 24 ===
