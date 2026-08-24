import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../types";

const daySummaries = vi.fn();
const getDayNote = vi.fn();
const thoughtsBetween = vi.fn();

vi.mock("../api", () => ({
  api: {
    daySummaries: (...a: unknown[]) => daySummaries(...a),
    getDayNote: (...a: unknown[]) => getDayNote(...a),
    setDayNote: vi.fn().mockResolvedValue(null),
    thoughtsBetween: (...a: unknown[]) => thoughtsBetween(...a),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import CalendarView from "./CalendarView.svelte";

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    title: "Inspect the thing",
    description: null,
    due_at: Date.now(),
    priority: "normal",
    sound_path: null,
    repeat_rule: null,
    state: "pending",
    snooze_until: null,
    created_at: 1,
    updated_at: 1,
    source: "local",
    external_id: null,
    last_synced_at: null,
    silent: false,
    tags: [],
    task_lane_id: null,
    task_sort_key: null,
    ...overrides,
  };
}

// A timestamp on today's calendar date at the given hour — keeps every
// reminder on the same day-cell as "today" while giving each a distinct,
// orderable due time.
function todayAt(hour: number): number {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

describe("CalendarView day selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    daySummaries.mockResolvedValue({ days_with_notes: [], thought_times: [] });
    getDayNote.mockResolvedValue(null);
    thoughtsBetween.mockResolvedValue([]);
  });

  function mount(reminders: Reminder[] = [reminder()]) {
    const onSelect = vi.fn();
    const onCreateForDate = vi.fn();
    const r = render(CalendarView, {
      props: { reminders, onSelect, onCreateForDate },
    });
    return { ...r, onSelect, onCreateForDate };
  }

  it("opens the day panel when a day is clicked", async () => {
    const user = userEvent.setup();
    mount();
    const today = new Date();
    await user.click(screen.getByLabelText(`Open ${today.getDate()}`));
    expect(await screen.findByPlaceholderText("What happened?")).toBeTruthy();
  });

  it("asks the backend for that day's note", async () => {
    const user = userEvent.setup();
    mount();
    const today = new Date();
    await user.click(screen.getByLabelText(`Open ${today.getDate()}`));
    const { localDayKey } = await import("../day");
    expect(getDayNote).toHaveBeenCalledWith(localDayKey(today));
  });

  it("opens the day panel via the keyboard", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    const today = new Date();
    const cell = screen.getByLabelText(`Open ${today.getDate()}`);
    cell.focus();
    await user.keyboard("{Enter}");
    await screen.findByPlaceholderText("What happened?");
    expect(container.querySelector(".panel")?.getAttribute("aria-hidden")).toBe("false");
  });

  // DayPanel (Task 6) is mounted unconditionally and toggles visibility via
  // CSS + aria-hidden rather than {#if}, so its textarea is always in the
  // DOM — presence alone can't distinguish open from closed. Check the
  // panel's own open state instead.
  it("opens a reminder item without also opening the day panel", async () => {
    const user = userEvent.setup();
    const { onSelect, container } = mount();
    await user.click(await screen.findByText("Inspect the thing"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
    const panel = container.querySelector(".panel");
    expect(panel?.getAttribute("aria-hidden")).toBe("true");
  });

  it("opens the day panel when '+N more' is clicked", async () => {
    const user = userEvent.setup();
    const { container } = mount([
      reminder({ id: "a", title: "One", due_at: todayAt(1) }),
      reminder({ id: "b", title: "Two", due_at: todayAt(2) }),
      reminder({ id: "c", title: "Three", due_at: todayAt(3) }),
      reminder({ id: "d", title: "Four", due_at: todayAt(4) }),
      reminder({ id: "e", title: "Five", due_at: todayAt(5) }),
    ]);
    await user.click(screen.getByText("+1 more"));
    await screen.findByPlaceholderText("What happened?");
    expect(container.querySelector(".panel")?.getAttribute("aria-hidden")).toBe("false");
  });
});
