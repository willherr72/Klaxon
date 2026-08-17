import { render, screen } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Reminder } from "../types";

// The editor loads lanes on mount and subscribes to lane changes; neither
// has a Tauri host here.
vi.mock("../api", () => ({
  api: { listLanes: vi.fn().mockResolvedValue([]) },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import ReminderEditor from "./ReminderEditor.svelte";

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "r1",
    title: "Original title",
    description: null,
    due_at: Date.parse("2026-09-01T10:00:00Z"),
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

const noop = () => {};

function mount(props: Record<string, unknown> = {}) {
  return render(ReminderEditor, {
    props: {
      open: true,
      reminder: reminder(),
      seedToken: 1,
      onClose: noop,
      onSave: noop,
      onDelete: noop,
      onComplete: noop,
      ...props,
    },
  });
}

const titleBox = () => screen.getByPlaceholderText("Remember what?") as HTMLInputElement;

describe("ReminderEditor seeding", () => {
  beforeEach(() => vi.clearAllMocks());

  it("seeds the fields from the reminder it is opened with", () => {
    mount();
    expect(titleBox().value).toBe("Original title");
  });

  // The regression this exists for. Every mutating command now emits
  // reminders-changed, so the list refreshes constantly and hands the editor
  // a NEW object for the same row. Re-seeding on that would throw away
  // whatever the user had typed but not yet saved.
  it("keeps unsaved edits when the same reminder arrives as a fresh object", async () => {
    const user = userEvent.setup();
    const { rerender } = mount();

    await user.clear(titleBox());
    await user.type(titleBox(), "Half-typed thought");
    expect(titleBox().value).toBe("Half-typed thought");

    // What a list refresh looks like from here: same id, different object,
    // and a stale title from before the edit.
    await rerender({
      open: true,
      reminder: reminder({ title: "Original title", updated_at: 999 }),
      seedToken: 1,
      onClose: noop,
      onSave: noop,
      onDelete: noop,
      onComplete: noop,
    });

    expect(titleBox().value).toBe("Half-typed thought");
  });

  // The other half: a deliberate open MUST re-seed, or the editor shows the
  // previous item's contents. Keying on the reminder id alone got this
  // wrong for "new item" opens, which is how a task could be saved into the
  // wrong lane.
  it("re-seeds when the seed token changes, even for the same reminder", async () => {
    const user = userEvent.setup();
    const { rerender } = mount();

    await user.clear(titleBox());
    await user.type(titleBox(), "Half-typed thought");

    await rerender({
      open: true,
      reminder: reminder({ title: "Reopened title" }),
      seedToken: 2,
      onClose: noop,
      onSave: noop,
      onDelete: noop,
      onComplete: noop,
    });

    expect(titleBox().value).toBe("Reopened title");
  });

  // Two "new item" opens in a row are the case that has no id to key on:
  // only the token distinguishes them, and the second must not inherit the
  // first's defaults.
  it("re-seeds between two consecutive new-item opens", async () => {
    const { rerender } = mount({
      reminder: null,
      defaultTitle: "From a thought",
      seedToken: 1,
    });
    expect(titleBox().value).toBe("From a thought");

    await rerender({
      open: true,
      reminder: null,
      defaultTitle: "",
      seedToken: 2,
      onClose: noop,
      onSave: noop,
      onDelete: noop,
      onComplete: noop,
    });

    expect(titleBox().value).toBe("");
  });
});
