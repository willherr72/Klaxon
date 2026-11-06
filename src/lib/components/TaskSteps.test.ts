import { render, screen, waitFor, cleanup } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listSteps: vi.fn(), addStep: vi.fn(), updateStep: vi.fn(), moveStep: vi.fn(), deleteStep: vi.fn(), listener: undefined as (() => void) | undefined }));
vi.mock("../api", () => ({api:mocks}));
vi.mock("@tauri-apps/api/event", () => ({listen: vi.fn(async (_event, fn) => {mocks.listener = fn; return () => {};})}));
import TaskSteps from "./TaskSteps.svelte";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSteps.mockResolvedValue([{id:"one",task_id:"task",title:"Publish",completed:false,sort_key:0},{id:"two",task_id:"task",title:"Test",completed:false,sort_key:1}]);
  mocks.addStep.mockResolvedValue({}); mocks.updateStep.mockResolvedValue({}); mocks.moveStep.mockResolvedValue([]);
});
afterEach(cleanup);
it("moves using stable neighbor IDs and completes only the selected step", async () => {
  render(TaskSteps,{taskId:"task"}); const user=userEvent.setup();
  await user.click(await screen.findByLabelText("Move Test up"));
  expect(mocks.moveStep).toHaveBeenCalledWith("two","one");
  await user.click(screen.getByLabelText("Complete Publish"));
  expect(mocks.updateStep).toHaveBeenCalledWith("one",null,true);
});
it("keeps a failed draft and refreshes when an agent or peer changes steps", async () => {
  render(TaskSteps,{taskId:"task"}); const user=userEvent.setup();
  await screen.findByLabelText("Complete Publish");
  mocks.addStep.mockRejectedValueOnce(new Error("offline"));
  await user.type(screen.getByLabelText("New step"),"Review");
  await user.click(screen.getByText("Add step"));
  expect((await screen.findByRole("alert")).textContent).toContain("offline");
  expect((screen.getByLabelText("New step") as HTMLInputElement).value).toBe("Review");
  mocks.listSteps.mockResolvedValue([{id:"two",title:"Agent edit",completed:false}]); mocks.listener?.();
  await waitFor(() => expect(screen.getByText("Agent edit")).toBeTruthy());
});
