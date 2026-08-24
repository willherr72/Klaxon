import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { listen } from "@tauri-apps/api/event";
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

  // A couple of tests below override `listen`'s implementation to capture
  // the event callback. `vi.clearAllMocks()` in beforeEach resets call
  // history but not a swapped-in implementation, so restore the module's
  // default (an immediately-resolved no-op unlisten) after every test.
  afterEach(() => {
    vi.mocked(listen).mockResolvedValue(() => {});
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

  // The third mandatory flush path: the panel can also disappear because the
  // parent stops rendering it (e.g. navigating away), not just via close()
  // or a day switch. onDestroy must flush just as hard.
  it("flushes a pending note when the component is destroyed", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = mount();
    await user.type(noteBox(), "half typed");
    expect(setDayNote).not.toHaveBeenCalled();

    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "half typed");
  });

  // A day switch must clear the box immediately, not once the fetch for the
  // new day resolves — otherwise every switch briefly shows the previous
  // day's text.
  it("clears the note box immediately when switching days, before the new day's note loads", async () => {
    getDayNote.mockResolvedValueOnce({
      day: "2026-08-23",
      body: "yesterday's note",
      created_at: 1,
      updated_at: 1,
    });
    const { rerender } = mount();
    await waitFor(() => expect(noteBox().value).toBe("yesterday's note"));

    let resolveNext!: (v: unknown) => void;
    getDayNote.mockImplementationOnce(
      () => new Promise((resolve) => { resolveNext = resolve; }),
    );

    await rerender({
      open: true,
      date: new Date(2026, 7, 24, 12, 0),
      reminders: [],
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onCreateForDate: vi.fn(),
    });

    // The fetch for 2026-08-24 is still hanging at this point — if the box
    // still reads yesterday's text, the clear isn't synchronous.
    expect(noteBox().value).toBe("");

    // Switching days must still load the new day's body once its fetch
    // resolves — the synchronous clear must not turn into a permanent one.
    resolveNext({ day: "2026-08-24", body: "24th's note", created_at: 1, updated_at: 1 });
    await waitFor(() => expect(noteBox().value).toBe("24th's note"));
  });

  // A late-resolving fetch for the day the user is already typing on must
  // not clobber what they typed — their keystrokes are newer than whatever
  // that fetch returns.
  it("does not let a late-resolving fetch overwrite text already typed for the new day", async () => {
    const { rerender } = mount();
    await waitFor(() => expect(getDayNote).toHaveBeenCalledWith("2026-08-23"));

    let resolveNext!: (v: unknown) => void;
    getDayNote.mockImplementationOnce(
      () => new Promise((resolve) => { resolveNext = resolve; }),
    );

    await rerender({
      open: true,
      date: new Date(2026, 7, 24, 12, 0),
      reminders: [],
      onClose: vi.fn(),
      onSelect: vi.fn(),
      onCreateForDate: vi.fn(),
    });

    const user = userEvent.setup();
    await user.type(noteBox(), "new day text");

    // The stale fetch for 2026-08-24 finally resolves with a different body
    // — it must lose to what the user already typed for that same day.
    resolveNext({ day: "2026-08-24", body: "stale from server", created_at: 1, updated_at: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(noteBox().value).toBe("new day text");
  });

  // Two overlapping saves must not be allowed to resolve out of order: if
  // the earlier call is still in flight, the later one must wait for it
  // rather than racing it to the backend.
  it("keeps overlapping saves in issue order — a slow first save is not overtaken by a later one", async () => {
    let resolveFirst!: (v: unknown) => void;
    setDayNote.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );

    mount();
    const user = userEvent.setup();
    await user.type(noteBox(), "A");
    await screen.getByLabelText("Close day").click();
    await new Promise((r) => setTimeout(r, 0));

    expect(setDayNote).toHaveBeenCalledTimes(1);
    expect(setDayNote).toHaveBeenNthCalledWith(1, "2026-08-23", "A");

    // A second save is issued while the first is still unresolved.
    await user.type(noteBox(), "B");
    await screen.getByLabelText("Close day").click();
    await new Promise((r) => setTimeout(r, 0));

    // The second setDayNote must not have been issued yet: the first is
    // still in flight.
    expect(setDayNote).toHaveBeenCalledTimes(1);

    resolveFirst({ day: "2026-08-23", body: "A", created_at: 1, updated_at: 1 });
    await new Promise((r) => setTimeout(r, 0));

    expect(setDayNote).toHaveBeenCalledTimes(2);
    expect(setDayNote).toHaveBeenNthCalledWith(2, "2026-08-23", "AB");
  });

  // `pending` is cleared the instant the debounce dispatches a save, well
  // before a slow fetch (cold start, busy device) resolves. A guard keyed
  // only on `pending` would reopen the clobber window right after the save
  // fires. This reproduces that exact sequence: fetch hangs, user types,
  // the debounce fires and dispatches the save (pending -> null), and only
  // then does the stale fetch resolve.
  it("does not let a fetch that resolves after the debounce already fired overwrite what was typed", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    let resolveNote!: (v: unknown) => void;
    getDayNote.mockImplementationOnce(
      () => new Promise((resolve) => { resolveNote = resolve; }),
    );

    mount();
    await user.type(noteBox(), "hello");

    // The debounce fires and dispatches the save — `pending` is now null,
    // even though the initial fetch from mount() is still hanging.
    await vi.advanceTimersByTimeAsync(1000);
    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "hello");

    // The slow fetch finally resolves with a different (stale) body.
    resolveNote({ day: "2026-08-23", body: "stale from before", created_at: 1, updated_at: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(noteBox().value).toBe("hello");
  });

  // The sync-listener path (klaxon://day-notes-changed) is a second entry
  // point into the same clobber hazard as above, but with its own fetch
  // and its own guard. `pending === null` alone is not enough: the user
  // can keep typing AFTER the listener's own getDayNote is already in
  // flight, and that keystroke must win over whatever the fetch returns.
  it("does not let the sync-change listener overwrite text typed while its own fetch is in flight", async () => {
    vi.useFakeTimers();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    let fireChange: () => void = () => {};
    vi.mocked(listen).mockImplementation(
      ((_event: string, cb: () => void) => {
        fireChange = cb;
        return Promise.resolve(() => {});
      }) as typeof listen,
    );

    mount();
    await vi.advanceTimersByTimeAsync(0); // let mount's own getDayNote settle

    await user.type(noteBox(), "first");
    // The debounce fires and dispatches the save — `pending` goes back to
    // null well before any fetch below resolves.
    await vi.advanceTimersByTimeAsync(1000);
    expect(setDayNote).toHaveBeenCalledWith("2026-08-23", "first");

    // A change notification arrives (this device's own write, or the other
    // device syncing in) and the listener's own getDayNote hangs.
    let resolveListenerFetch!: (v: unknown) => void;
    getDayNote.mockImplementationOnce(
      () => new Promise((resolve) => { resolveListenerFetch = resolve; }),
    );
    fireChange();
    await vi.advanceTimersByTimeAsync(0);

    // The user keeps typing while that fetch is still hanging.
    await user.type(noteBox(), " more");

    // The hung fetch finally resolves with a stale body — it must lose to
    // what's already on screen.
    resolveListenerFetch({ day: "2026-08-23", body: "stale from before", created_at: 1, updated_at: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(noteBox().value).toBe("first more");
  });

  // If the component is destroyed while `listen`'s promise is still
  // pending, `unlistenNotes` was never assigned, so onDestroy's guard
  // (`if (unlistenNotes) unlistenNotes()`) used to no-op and leak the
  // listener forever.
  it("unregisters the sync listener even if the component is destroyed before `listen` resolves", async () => {
    const unlistenSpy = vi.fn();
    let resolveListen!: () => void;
    vi.mocked(listen).mockImplementation(
      (() => new Promise((resolve) => {
        resolveListen = () => resolve(unlistenSpy);
      })) as typeof listen,
    );

    const { unmount } = mount();
    unmount();

    // `listen` only resolves after the component is already gone.
    resolveListen();
    await new Promise((r) => setTimeout(r, 0));

    expect(unlistenSpy).toHaveBeenCalledTimes(1);
  });
});
