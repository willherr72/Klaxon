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
<div class="agent-access">
  <p class="intro">Connect your preferred agent to plan work, organize tasks and steps, or capture reminders and thoughts. Keep Klaxon open while connected.</p>
  <p class="privacy">Your agent can read tasks, reminders, notes, and thoughts. A hosted agent may send that content to its model provider. Only enable access for clients you trust.</p>
  <form onsubmit={e => { e.preventDefault(); add(); }}>
    <div class="connect-row">
      <label class="field">
        <span class="mono-caps-faint">Client name</span>
        <input bind:value={name} maxlength="80" placeholder="My planning agent" />
      </label>
      <button class="primary-btn" disabled={busy || !name.trim()}>Connect agent</button>
    </div>
    <label class="toggle-row">
      <input class="toggle-input" type="checkbox" bind:checked={write} />
      <span class="toggle-knob" aria-hidden="true"></span>
      <span class="toggle-text">
        <span class="toggle-title">Allow changes</span>
        <span class="hint">Tasks, steps, reminders, thoughts and day notes. Off gives read-only access.</span>
      </span>
    </label>
    <p class="hint">Connections and access changes take effect immediately.</p>
  </form>

  <div class="subhead">
    <h4 class="mono-caps">Connected agents</h4>
    <span class="count">{clients.length}</span>
  </div>
  {#if clients.length}
    <ul class="client-list">
      {#each clients as client (client.id)}
        <li class="client-row">
          <div class="client-info">
            <span class="client-name">{client.name}</span>
            <span class="access-badge" class:writable={client.write}>{client.write ? "Read and write" : "Read only"}</span>
          </div>
          <div class="actions">
            <button class="ghost-btn" disabled={busy} onclick={() => act(async () => config = JSON.stringify(await invoke("agent_client_config", {id:client.id}), null, 2))}>Show configuration</button>
            <button class="ghost-btn danger" disabled={busy} onclick={() => act(async () => {await invoke("agent_revoke_client", {id:client.id}); config = "";})}>Revoke</button>
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No agents connected.</p>
  {/if}

  {#if config}
    <label class="field">
      <span class="mono-caps-faint">MCP configuration</span>
      <textarea readonly rows="9" spellcheck="false" value={config} onfocus={e => e.currentTarget.select()}></textarea>
    </label>
    <p class="hint">Add this to your agent's MCP server settings. Access is local to this computer; changes reach your phone through normal device sync.</p>
  {/if}

  <div class="subhead activity-head">
    <h4 class="mono-caps">Recent agent changes</h4>
    <button class="ghost-btn" disabled={busy} onclick={() => act(refresh)}>Refresh activity</button>
  </div>
  {#if activity.length}
    <ul class="activity-list">
      {#each activity as entry}
        <li class="activity-row">
          <div class="activity-meta">
            <time datetime={new Date(entry.created_at).toISOString()}>{new Date(entry.created_at).toLocaleString()}</time>
            <span>{clients.find(c => c.id === entry.client_id)?.name ?? "Revoked client"}</span>
          </div>
          <span class="activity-tool mono-caps">{entry.tool.replaceAll("_", " ")}</span>
          <p>{entry.summary}</p>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">No agent changes yet.</p>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .agent-access { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  p { font-size: 11px; line-height: 1.6; }
  .intro { color: var(--text-2); }
  .privacy { color: var(--text-2); border-left: 2px solid var(--klaxon-dim); padding-left: 12px; }
  .hint { font-size: 10px; line-height: 1.6; color: var(--text-muted); }
  form { display: flex; flex-direction: column; gap: 8px; }
  .connect-row { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 12px; }
  .connect-row .field { flex: 1; min-width: min(100%, 180px); }
  .field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .field input, textarea {
    width: 100%; min-width: 0; padding: 8px 10px;
    background: var(--bg-surface); border: 1px solid var(--border);
    color: var(--text); font-family: var(--font-mono); font-size: 11px;
    border-radius: 0; transition: border-color 120ms var(--ease);
  }
  .field input:focus, textarea:focus { border-color: var(--klaxon); }
  .field input::placeholder { color: var(--text-muted); }
  textarea { resize: vertical; line-height: 1.6; user-select: text; }
  .toggle-row { display: flex; align-items: center; gap: 14px; padding: 8px 0; cursor: pointer; position: relative; }
  .toggle-input { position: absolute; width: 1px; height: 1px; opacity: 0; }
  .toggle-knob {
    flex-shrink: 0; position: relative; width: 44px; height: 22px;
    background: var(--bg-surface); border: 1px solid var(--border-strong);
    transition: all 140ms var(--ease);
  }
  .toggle-knob::before {
    content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px;
    background: var(--text-muted); transition: all 140ms var(--ease);
  }
  .toggle-input:checked + .toggle-knob { border-color: var(--klaxon); background: var(--klaxon-glow); }
  .toggle-input:checked + .toggle-knob::before { left: 25px; background: var(--klaxon); box-shadow: 0 0 8px var(--klaxon-glow-strong); }
  .toggle-input:focus-visible + .toggle-knob { outline: 1px solid var(--klaxon); outline-offset: 2px; }
  .toggle-text { display: flex; flex-direction: column; gap: 3px; }
  .toggle-title { font-size: 12px; color: var(--text); font-weight: 500; }
  .subhead { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
  .subhead h4 { letter-spacing: 0.22em; font-size: 11px; }
  .count { padding: 2px 8px; border: 1px solid var(--border-strong); color: var(--text-muted); font-size: 10px; }
  .activity-head { justify-content: space-between; }
  ul { list-style: none; }
  .client-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); }
  .client-info { display: flex; align-items: flex-start; flex-direction: column; gap: 6px; min-width: 0; }
  .client-name { font-size: 12px; overflow-wrap: anywhere; }
  .access-badge { padding: 2px 6px; border: 1px solid var(--border-strong); color: var(--text-muted); font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; }
  .access-badge.writable { color: var(--klaxon); border-color: var(--klaxon-dim); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .ghost-btn, .primary-btn {
    padding: 8px 12px; border: 1px solid var(--border-strong);
    font-family: var(--font-mono); font-size: 9px; text-transform: uppercase;
    letter-spacing: 0.22em; color: var(--text-2); transition: all 120ms var(--ease);
  }
  .ghost-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-bright); }
  .ghost-btn.danger:hover:not(:disabled) { color: var(--signal-high); border-color: var(--signal-high); }
  .primary-btn { background: var(--klaxon); color: var(--bg); border-color: var(--klaxon); font-weight: 700; }
  .primary-btn:hover:not(:disabled) { background: transparent; color: var(--klaxon); box-shadow: 0 0 14px var(--klaxon-glow); }
  button:disabled { opacity: 0.4; cursor: not-allowed; }
  .empty { padding: 16px; border: 1px dashed var(--border); color: var(--text-muted); text-align: center; }
  .activity-row { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-bottom: 1px solid var(--border); overflow-wrap: anywhere; }
  .activity-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 10px; color: var(--text-muted); }
  .activity-row p { color: var(--text-2); }
  .error { padding: 8px 12px; border: 1px solid var(--signal-high); color: var(--signal-high); overflow-wrap: anywhere; }
</style>
