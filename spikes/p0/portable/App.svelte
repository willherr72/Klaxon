<script>
  import { onMount } from "svelte";
  import { signIn } from "./account.js";
  import { readFixture, saveFixture } from "./fixture.js";

  const origin = P0_PORTABLE_ORIGIN;
  let online = $state(navigator.onLine);
  let session = $state.raw(null);
  let connected = $state(false);
  let authenticated = $state(false);
  let rows = $state([]);
  let receivedAt = $state("");
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let username = $state("");
  let password = $state("");
  let title = $state("");
  let editing = $state(null);
  let renamed = $state("");
  let canWrite = $derived(!busy && (!origin || (online && authenticated && connected && !!receivedAt)));

  function receive(tasks) {
    rows = tasks;
    receivedAt = new Date().toISOString();
  }
  function loadFixture() {
    try { receive(readFixture()); }
    catch { error = "Could not read device storage. Reopen the same file or app with storage enabled."; }
  }
  onMount(() => { if (!origin) loadFixture(); });

  async function perform(action) {
    if (busy) return;
    busy = true;
    error = "";
    notice = "";
    try { await action(); }
    catch (err) { error = err.message; }
    finally { busy = false; }
  }
  function endSession() {
    session = null;
    connected = false;
    authenticated = false;
    rows = [];
    receivedAt = "";
    title = "";
    editing = null;
    renamed = "";
  }
  async function login() {
    if (!P0_PORTABLE_ORIGIN) return;
    const credentials = password;
    password = "";
    session = await signIn(origin, username.trim(), credentials, {
      connected: value => { connected = value; },
      authenticated: value => { authenticated = value; },
      rows: receive,
      error: message => { error = message; },
      expired: () => { endSession(); error = "Session expired. Sign in again."; },
    });
    notice = "Signed in.";
  }
  async function save(id, draft) {
    const value = draft.trim();
    if (!value) return;
    if (origin) {
      try {
        if (id) await session.rename(id, value);
        else await session.create(value);
      } catch {
        throw new Error("Server write unconfirmed. Read tasks after reconnecting before retrying.");
      }
    } else {
      try {
        saveFixture(id ?? crypto.randomUUID(), value);
        receive(readFixture());
      } catch {
        throw new Error("Could not save to device storage. Check available space and retry.");
      }
    }
    if (id) { editing = null; renamed = ""; }
    else title = "";
    notice = origin ? "Server acknowledged the write." : "Saved on this device.";
  }
  async function read() {
    if (origin) {
      receive(await session.read());
      notice = "Read from the server.";
    } else {
      loadFixture();
      if (!error) notice = "Read from device storage.";
    }
  }
  function submit(event, action) { event.preventDefault(); void perform(action); }
</script>

<svelte:window ononline={() => { online = true; }} onoffline={() => { online = false; }} />
<header>
  <span class="brand">Klaxon</span>
  <span class="mode">{origin ? "Convex account" : "Local fixture"}</span>
</header>
<h1>Device check</h1>
<p class="summary">{origin ? "Use a previously enrolled synthetic account." : "Synthetic tasks are stored in this browser profile on this device."}</p>
{#if origin}<p class="endpoint">{origin}</p>{/if}
<div class="network">
  <span class:offline={!online}>Browser network {online ? "online" : "offline"}</span>
  {#if origin && session}
    <span>{!online || !connected ? "Subscription disconnected" : !authenticated ? "Verifying session" : "Subscription connected"}</span>
  {/if}
</div>

{#if origin && !session}
  <form onsubmit={e => submit(e, login)}>
    <label>Username <input bind:value={username} autocomplete="off" required /></label>
    <label>Password <input type="password" bind:value={password} autocomplete="off" required /></label>
    <button disabled={busy || !online || !username.trim() || !password}>Sign in</button>
  </form>
{:else}
  {#if session}
    <div class="actions">
      <button class="secondary" disabled={busy || !online} onclick={() => perform(async () => { await session.refresh(); notice = "Session refreshed."; })}>Refresh session</button>
      <button class="secondary" disabled={busy || !online} onclick={() => perform(async () => { await session.signOut(); endSession(); notice = "Signed out."; })}>Sign out</button>
    </div>
  {/if}
  <form onsubmit={e => submit(e, () => save(null, title))}>
    <label>Task title <input bind:value={title} required maxlength="200" /></label>
    <button disabled={!canWrite || !title.trim()}>Create task</button>
  </form>
  <section aria-labelledby="tasks-heading">
    <div class="heading"><h2 id="tasks-heading">Synthetic tasks</h2>
      <button class="secondary" disabled={busy || (origin && !online)} onclick={() => perform(read)}>Read tasks</button>
    </div>
    {#if receivedAt}
      <p class="stamp">{origin && (!connected || !online) ? "Last available rows" : "Last read"} <time datetime={receivedAt}>{receivedAt}</time></p>
    {/if}
    {#if rows.length === 0}<p>{receivedAt ? "No synthetic tasks." : "Waiting for tasks."}</p>{/if}
    <ul aria-label="Synthetic tasks">
      {#each rows as row (row._id)}
        <li data-task-id={row._id}>
          <strong>{row.title}</strong><small>{row._id}</small>
          {#if editing === row._id}
            <form onsubmit={e => submit(e, () => save(row._id, renamed))}>
              <label>New title <input bind:value={renamed} required maxlength="200" /></label>
              <div class="actions">
                <button disabled={!canWrite || !renamed.trim()}>Save title</button>
                <button type="button" class="secondary" disabled={busy} onclick={() => { editing = null; }}>Cancel</button>
              </div>
            </form>
          {:else}
            <button class="secondary" disabled={!canWrite} onclick={() => { editing = row._id; renamed = row.title; }}>Rename</button>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}
{#if error}<p role="alert">{error}</p>{/if}
<p role="status">{busy ? "Working…" : notice}</p>
