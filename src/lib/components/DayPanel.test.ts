import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../types";

const getDayNote = vi.fn();
const setDayNote = vi.fn();
const thoughtsBetween = vi.fn();

vi.mock("../api", () => ({
  api: {
    getDayNote: (...a: unknown[]) => getDayNote(...a),
    setDayNote: (...a: unknown[]) => setDayNote(...a),
    thoughtsBetween: (...a: unknown[]) => thoughtsBetween(...a),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import DayPanel from "./DayPanel.svelte";

const DAY = new Date(2026, 7, 23, 12, 0);

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    title: "Pending thing",
    description: null,
    due_at: new Date(2026, 7, 23, 9, 0).getTime(),
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

function mount(props: Record<string, unknown> = {}) {
  const onClose = vi.fn();
  const onSelect = vi.fn();
  const onCreateForDate = vi.fn();
  const r = render(DayPanel, {
    props: {
      open: true,
      date: DAY,
      reminders: [reminder()],
      onClose,
      onSelect,
      onCreateForDate,
      ...props,
    },
  });
  return { ...r, onClose, onSelect, onCreateForDate };
}

const noteBox = () => screen.getByPlaceholderText("What happened?") as HTMLTextAreaElement;

describe("DayPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    getDayNote.mockResolvedValue(null);
    setDayNote.mockResolvedValue({ day: "2026-08-23", body: "", created_at: 1, updated_at: 1 });
    thoughtsBetween.mockResolvedValue([]);
  });

  it("loads the note for the day it is opened on", async () => {
    getDayNote.mockResolvedValue({
      day: "2026-08-23",
      body: "shipped v0.9.0",
      created_at: 1,
      updated_at: 1,
    });
    mount();
    await waitFor(() => expect(noteBox().value).toBe("shipped v0.9.0"));
    expect(getDayNote).toHaveBeenCalledWith("2026-08-23");
  });

  // The whole point of showing a day: finished items count as "what
  // happened", so they must be listed, not filtered out like the grid does.
  it("lists both unfinished and finished items for the day", async () => {
    mount({
      reminders: [
        reminder({ id: "a", title: "Still pending" }),
        reminder({ id: "b", title: "Already done", state: "completed" }),
      ],
    });
    expect(await screen.findByText("Still pending")).toBeTruthy();
    expect(screen.getByText("Already done")).toBeTruthy();
  });

  it("ignores items belonging to other days", async () => {
    mount({
      reminders: [
        reminder({ id: "a", title: "Today's thing" }),
        reminder({
          id: "b",
          title: "Tomorrow's thing",
          due_at: new Date(2026, 7, 24, 9, 0).getTime(),
        }),
      ],
    });
    expect(await screen.findByText("Today's thing")).toBeTruthy();
    expect(screen.queryByText("Tomorrow's thing")).toBeNull();
  });

  it("opens a reminder when its row is clicked", async () => {
    const user = userEvent.setup();
    const { onSelect } = mount();
    await user.click(await screen.findByText("Pending thing"));
    expect(onSelect).toHaveBeenCalled();
  });

  // Autosave: one write after the pause, not one per keystroke.
  it("saves once after typing stops", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await user.type(noteBox(), "went well");
    expect(setDayNote).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(setDayNote).toHaveBeenCalledTimes(1);
    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "went well");
  });

  // The flush that matters: an unflushed debounce discards the note.
  it("flushes a pending note when the panel closes", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender, onClose } = mount();
    await user.type(noteBox(), "half typed");
    expect(setDayNote).not.toHaveBeenCalled();

    await screen.getByLabelText("Close day").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "half typed");
    expect(onClose).toHaveBeenCalled();
    void rerender;
  });

  // Switching days is as dangerous as closing: the panel swaps contents in
  // place, so an unflushed note would be replaced by the next day's body.
  it("flushes a pending note when switching to another day", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { rerender } = mount();
    await user.type(noteBox(), "half typed");

    await rerender({
      open: true,
      date: new Date(2026, 7, 24, 12, 0),
      reminders: [],
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onCreateForDate: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "half typed");
  });
});
