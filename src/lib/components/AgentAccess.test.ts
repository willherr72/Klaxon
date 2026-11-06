import { render, screen, cleanup, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke=vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({invoke}));
import AgentAccess from "./AgentAccess.svelte";
beforeEach(() => { invoke.mockReset();invoke.mockImplementation(async (command) => command === "agent_add_client" ? {mcpServers:{klaxon:{command:"klaxon",args:["--mcp"]}}} : []); });
afterEach(cleanup);
it("defaults a new client to read-only and displays configuration only after creation", async () => {
  render(AgentAccess);const user=userEvent.setup();
  await user.type(screen.getByLabelText("Client name"),"Planner");
  await user.click(screen.getByText("Connect agent"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_add_client",{name:"Planner",write:false}));
  expect((await screen.findByLabelText("MCP configuration") as HTMLTextAreaElement).value).toContain("--mcp");
});
it("revokes the selected client and removes the displayed configuration", async () => {
  invoke.mockImplementation(async (command) => command === "agent_clients" ? [{id:"c",name:"Planner",write:true}] : command === "agent_client_config" ? {mcpServers:{klaxon:{command:"klaxon"}}} : []);
  render(AgentAccess);const user=userEvent.setup();
  await user.click(await screen.findByText("Show configuration"));
  await screen.findByLabelText("MCP configuration");
  await user.click(screen.getByText("Revoke"));
  expect(invoke).toHaveBeenCalledWith("agent_revoke_client",{id:"c"});
  await waitFor(() => expect(screen.queryByLabelText("MCP configuration")).toBeNull());
});
