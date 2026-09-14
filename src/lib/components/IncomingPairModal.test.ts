import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingPairEvent } from "../api";

const { listeners, approve, decline, register } = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  approve: vi.fn(),
  decline: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: register }));
vi.mock("../api", () => ({
  api: { approvePairRequest: approve, declinePairRequest: decline },
}));

import IncomingPairModal from "./IncomingPairModal.svelte";

function request(request_id = "first"): PendingPairEvent {
  return {
    request_id,
    initiator_id: `device-${request_id}`,
    initiator_name: `Phone ${request_id}`,
    initiator_url: "iroh://phone",
    confirmation_code: "123456",
  };
}

async function emit(name: string, payload: unknown) {
  listeners.get(name)?.({ payload });
  await tick();
}

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  approve.mockResolvedValue(undefined);
  decline.mockResolvedValue(undefined);
  register.mockImplementation(async (name, handler) => {
    listeners.set(name, handler);
    return () => listeners.delete(name);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("IncomingPairModal", () => {
  it("dismisses a request when the backend closes it after expiration", async () => {
    render(IncomingPairModal);
    await tick();
    await emit("klaxon://pair-request", request());
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await emit("klaxon://pair-request-closed", { request_id: "first" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("does not dismiss a newer request when an older request expires", async () => {
    render(IncomingPairModal);
    await tick();
    await emit("klaxon://pair-request", request());
    await emit("klaxon://pair-request", request("second"));
    await emit("klaxon://pair-request-closed", { request_id: "first" });
    expect(screen.getByText("Phone second")).toBeTruthy();
    await emit("klaxon://pair-request-closed", { request_id: "second" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it.each(["Approve", "Decline"])(
    "does not dismiss a newer request when an older %s command finishes",
    async (label) => {
      let finish!: () => void;
      const command = label === "Approve" ? approve : decline;
      command.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
      render(IncomingPairModal);
      await tick();
      await emit("klaxon://pair-request", request());
      await fireEvent.click(screen.getByRole("button", { name: label }));
      expect(command).toHaveBeenCalledWith("first");
      await emit("klaxon://pair-request", request("second"));
      finish();
      await command.mock.results[0].value;
      await tick();
      expect(screen.getByText("Phone second")).toBeTruthy();
      expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
    },
  );

  it("releases listeners and the timer when unmounted during listener registration", async () => {
    vi.useFakeTimers();
    const registrations: Array<() => void> = [];
    register.mockImplementation((name, handler) => new Promise((resolve) => {
      registrations.push(() => {
        listeners.set(name, handler);
        resolve(() => listeners.delete(name));
      });
    }));
    const view = render(IncomingPairModal);
    await tick();
    view.unmount();
    for (const finish of registrations) finish();
    await tick();
    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
