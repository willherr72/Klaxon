<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  type Client = { id: string; name: string; write: boolean };
  type Activity = { client_id: string; tool: string; created_at: number; summary: string };
  let clients = $state<Client[]>([]);
  let activity = $state<Activity[]>([]);
  let name = $state("");
  let write = $state(false);
  let config = $state("");
  let error = $state("");
  let busy = $state(false);
  async function refresh() {
    clients = await invoke<Client[]>("agent_clients");
    activity = await invoke<Activity[]>("agent_activity");
  }
  onMount(() => { refresh().catch(e => error = String(e)); });
  async function act(action: () => Promise<unknown>) {
    busy = true; error = "";
    try { await action(); await refresh(); } catch(e) { error = String(e); }
    finally { busy = false; }
  }
  async function add() {
    await act(async () => {
      config = JSON.stringify(await invoke("agent_add_client", {name, write}), null, 2);
      name = "";
    });
  }
</script>
<details class="agent-access">
  <summary>Agent access</summary>
  <p>Connect your preferred agent to plan work, organize tasks and steps, or capture reminders and thoughts. Keep Klaxon open while connected.</p>
  <p>Your agent can read tasks, reminders, notes, and thoughts. A hosted agent may send that content to its model provider. Only enable access for clients you trust.</p>
  <form onsubmit={e => { e.preventDefault(); add(); }}>
    <label>Client name <input bind:value={name} maxlength="80" placeholder="My planning agent" /></label>
    <label><input type="checkbox" bind:checked={write} /> Allow changes to tasks, steps, reminders, thoughts and day notes</label>
    <button disabled={busy || !name.trim()}>Connect agent</button>
  </form>
  <ul>
    {#each clients as client (client.id)}
      <li>
        <span>{client.name} · {client.write ? "Read and write" : "Read only"}</span>
        <button disabled={busy} onclick={() => act(async () => config = JSON.stringify(await invoke("agent_client_config", {id:client.id}), null, 2))}>Show configuration</button>
        <button disabled={busy} onclick={() => act(async () => {await invoke("agent_revoke_client", {id:client.id}); config = "";})}>Revoke</button>
      </li>
    {/each}
  </ul>
  {#if config}
    <label>MCP configuration <textarea readonly rows="9" value={config} onfocus={e => e.currentTarget.select()}></textarea></label>
    <p>Add this to your agent's MCP server settings. Access is local to this computer; changes reach your phone through normal device sync.</p>
  {/if}
  <h4>Recent agent changes</h4>
  <button disabled={busy} onclick={() => act(refresh)}>Refresh activity</button>
  <ul>
    {#each activity as entry}
      <li>{new Date(entry.created_at).toLocaleString()} · {clients.find(c => c.id === entry.client_id)?.name ?? "Revoked client"} · {entry.tool.replaceAll("_", " ")} · {entry.summary}</li>
    {/each}
  </ul>
  {#if !activity.length}<p>No agent changes yet.</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
</details>
<style>
  .agent-access { margin: 20px 0; padding: 16px; border: 1px solid #444; border-radius: 6px; }
  summary { cursor: pointer; font-weight: bold; } p, li { font-size: 12px; line-height: 1.6; } form { display: grid; gap: 12px; }
  input, textarea, button { background: transparent; color: inherit; border: 1px solid #555; padding: 7px; border-radius: 4px; }
  textarea { display: block; width: 100%; font-family: monospace; font-size: 11px; } li { margin: 8px 0; } li button { margin-left: 6px; }
  label { font-size: 12px; } button:disabled { opacity: .4; } [role=alert] { color: #f88; }
</style>
