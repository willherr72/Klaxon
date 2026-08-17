import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../types";

const listLanes = vi.fn();
const updateReminder = vi.fn();
const placeTask = vi.fn();
const sortLaneByStars = vi.fn();

vi.mock("../api", () => ({
  api: {
    listLanes: (...a: unknown[]) => listLanes(...a),
    updateReminder: (...a: unknown[]) => updateReminder(...a),
    placeTask: (...a: unknown[]) => placeTask(...a),
    sortLaneByStars: (...a: unknown[]) => sortLaneByStars(...a),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
// The drag library needs real pointer plumbing; the board's own logic is
// what's under test, so the zones become no-op actions.
vi.mock("svelte-dnd-action", () => ({
  dndzone: () => ({ update() {}, destroy() {} }),
  TRIGGERS: {
    DROPPED_INTO_ZONE: "droppedIntoZone",
    DROPPED_INTO_ANOTHER: "droppedIntoAnother",
  },
}));

import TasksBoard from "./TasksBoard.svelte";

const LANE = "lane-1";

function task(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "t1",
    title: "Inspect the thing",
    description: null,
    due_at: 0,
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
    silent: true,
    tags: [],
    task_lane_id: LANE,
    task_sort_key: 1024,
    ...overrides,
  };
}

describe("TasksBoard star control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLanes.mockResolvedValue([
      {
        id: LANE,
        name: "Todo",
        order_index: 0,
        is_default: true,
        created_at: 1,
        updated_at: 1,
      },
    ]);
    updateReminder.mockResolvedValue(task());
  });

  function mount(reminders: Reminder[], onSelect = vi.fn()) {
    render(TasksBoard, {
      props: { reminders, onSelect, onAddCardToLane: vi.fn() },
    });
    return { onSelect };
  }

  // The bug you reported: the stars looked inert. They were always writing;
  // this pins that a tap issues the update rather than doing nothing.
  it("writes the new priority when a star is tapped", async () => {
    const user = userEvent.setup();
    mount([task({ priority: "normal" })]);

    await user.click(await screen.findByTitle("Set priority: high"));

    expect(updateReminder).toHaveBeenCalledWith("t1", { priority: "high" });
  });

  it("can lower the priority as well as raise it", async () => {
    const user = userEvent.setup();
    mount([task({ priority: "high" })]);

    await user.click(await screen.findByTitle("Set priority: low"));

    expect(updateReminder).toHaveBeenCalledWith("t1", { priority: "low" });
  });

  // No-op writes would bump updated_at and push a pointless change to the
  // other device on every stray tap.
  it("does not write when the tapped star is already the current priority", async () => {
    const user = userEvent.setup();
    mount([task({ priority: "normal" })]);

    await user.click(await screen.findByTitle("Set priority: normal"));

    expect(updateReminder).not.toHaveBeenCalled();
  });

  // Cards open the editor on click, so the star has to swallow its own tap
  // or setting a priority would also open the task.
  it("does not open the editor when a star is tapped", async () => {
    const user = userEvent.setup();
    const { onSelect } = mount([task({ priority: "normal" })]);

    await user.click(await screen.findByTitle("Set priority: high"));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still opens the editor when the card itself is clicked", async () => {
    const user = userEvent.setup();
    const { onSelect } = mount([task()]);

    await user.click(await screen.findByText("Inspect the thing"));

    expect(onSelect).toHaveBeenCalled();
  });

  // Lanes render smallest-key-first; this is what makes a dragged position
  // survive a refresh rather than snapping back to the top.
  it("orders cards by their board position, not by recency", async () => {
    mount([
      task({ id: "bottom", title: "Bottom card", task_sort_key: 3072, updated_at: 999 }),
      task({ id: "top", title: "Top card", task_sort_key: 1024, updated_at: 1 }),
    ]);

    const titles = (await screen.findAllByText(/card$/)).map((el) => el.textContent);
    expect(titles).toEqual(["Top card", "Bottom card"]);
  });
});
