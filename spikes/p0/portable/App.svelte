<script>
  import { onMount } from "svelte";
  import { signIn } from "./account.js";
  import { readFixture, saveFixture } from "./fixture.js";

  const origin = P0_PORTABLE_ORIGIN;
  let online = $state(navigator.onLine);
  let session = $state.raw(null);
  let generation = 0;
  let connected = $state(false);
  let connectionCount = 0;
  let transportEpoch = 0;
  let authenticated = $state(false);
  let rows = $state([]);
  let rowsVersion = 0;
  let rowsFresh = $state(false);
  let readAfterWriteRequired = $state(false);
  let receivedAt = $state("");
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let username = $state("");
  let password = $state("");
  let title = $state("");
  let editing = $state(null);
  let renamed = $state("");
  let canWrite = $derived(!busy && !!receivedAt && (!origin ||
    (online && authenticated && connected && rowsFresh && !readAfterWriteRequired)));

  function markStale() {
    transportEpoch++;
    rowsFresh = false;
  }
  function updateOnline(value) {
    if (online && !value) markStale();
    online = value;
  }
  function updateConnection(state) {
    // The socket can reopen before the server has sent any task results.
    if ((connected && !state.isWebSocketConnected) ||
      (connectionCount > 0 && connectionCount !== state.connectionCount)) markStale();
    connected = state.isWebSocketConnected;
    connectionCount = state.connectionCount;
  }

  function receive(tasks, startedConnected = true) {
    rowsVersion++;
    rows = tasks;
    receivedAt = new Date().toISOString();
    rowsFresh = !origin || (startedConnected && online && connected);
  }
  function loadFixture() {
    try { receive(readFixture()); }
    catch {
      receivedAt = "";
      error = "Could not read device storage. Check the saved fixture and storage access, then read tasks again.";
    }
  }
  onMount(() => { if (!origin) loadFixture(); });

  async function perform(action) {
    if (busy) return;
    const started = generation;
    busy = true;
    error = "";
    notice = "";
    try { await action(); }
    catch (err) { if (generation === started) error = err.message; }
    finally { if (generation === started) busy = false; }
  }
  function endSession() {
    generation++;
    busy = false;
    notice = "";
    session = null;
    readAfterWriteRequired = false;
    markStale();
    connected = false;
    connectionCount = 0;
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
    const started = generation;
    const opened = await signIn(origin, username.trim(), credentials, {
      connection: updateConnection,
      authenticated: value => { authenticated = value; },
      rows: tasks => { if (online && connected) receive(tasks); },
      error: message => { markStale(); error = message; },
      expired: message => { endSession(); error = message; },
    });
    if (started !== generation) return;
    session = opened;
    notice = "Signed in.";
  }
  async function save(id, draft) {
    const value = draft.trim();
    if (!value) return;
    if (origin) {
      const active = session;
      try {
        if (id) await active.rename(id, value);
        else await active.create(value);
      } catch {
        if (active !== session) return;
        readAfterWriteRequired = true;
        throw new Error("Server write unconfirmed.");
      }
      if (active !== session) return;
    } else {
      try {
        receive(saveFixture(id ?? crypto.randomUUID(), value));
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
      const active = session;
      updateConnection(active.connectionState());
      const started = transportEpoch;
      const isCurrentRead = () => {
        if (active !== session) return false;
        updateConnection(active.connectionState());
        if (started === transportEpoch) return true;
        notice = rowsFresh ? "Connection changed during the read. Showing subscription updates."
          : "Connection changed during the read. Read tasks again.";
        return false;
      };
      let version = rowsVersion;
      let startedConnected = connected;
      try {
        let result = await active.read();
        if (!isCurrentRead()) return;
        // The two transports expose no common revision. A read started after the push
        // can reconcile either arrival order without guessing which title is newer.
        if (version !== rowsVersion) {
          version = rowsVersion;
          startedConnected = connected;
          result = await active.read();
          if (!isCurrentRead()) return;
          if (version !== rowsVersion) {
            notice = "Tasks changed during both reads. Showing subscription updates.";
            return;
          }
        }
        if (!Array.isArray(result) || !result.every(row => typeof row?._id === "string" &&
          row._id.length > 0 && typeof row.title === "string") ||
          new Set(result.map(row => row._id)).size !== result.length) {
          throw new Error("The server returned an invalid task list. Read tasks again.");
        }
        receive(result, startedConnected);
        notice = "Read from the server.";
        if (readAfterWriteRequired && rowsFresh && authenticated) {
          readAfterWriteRequired = false;
          notice += " Check the task list before submitting again.";
        }
      } catch (err) {
        if (isCurrentRead()) throw err;
      }
    } else {
      loadFixture();
      if (!error) notice = "Read from device storage.";
    }
  }
  async function refreshSession() {
    const active = session;
    await active.refresh();
    if (active === session) notice = "Session refreshed.";
  }
  async function signOut() {
    const active = session;
    await active.signOut();
    if (active !== session) return;
    endSession();
    notice = "Signed out.";
  }
  function submit(event, action) { event.preventDefault(); void perform(action); }
  function submitWrite(event, id, draft) {
    event.preventDefault();
    if (session) updateConnection(session.connectionState());
    if (canWrite) void perform(() => save(id, draft));
  }
</script>

<svelte:window ononline={() => updateOnline(true)} onoffline={() => updateOnline(false)} />
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
      <button class="secondary" disabled={busy || !online} onclick={() => perform(refreshSession)}>Refresh session</button>
      <button class="secondary" disabled={busy || !online} onclick={() => perform(signOut)}>Sign out</button>
    </div>
  {/if}
  <form onsubmit={e => submitWrite(e, null, title)}>
    <label>Task title <input bind:value={title} required maxlength="200" /></label>
    <button disabled={!canWrite || !title.trim()}>Create task</button>
  </form>
  <section aria-labelledby="tasks-heading">
    <div class="heading"><h2 id="tasks-heading">Synthetic tasks</h2>
      <button class="secondary" disabled={busy || (origin && !online)} onclick={() => perform(read)}>Read tasks</button>
    </div>
    {#if readAfterWriteRequired}
      <p>Select Read tasks to check whether your last change was saved.</p>
    {/if}
    {#if receivedAt}
      <p class="stamp">{origin && !rowsFresh ? "Last available rows" : "Last read"} <time datetime={receivedAt}>{receivedAt}</time></p>
    {/if}
    {#if rows.length === 0}<p>{receivedAt ? "No synthetic tasks." : "Waiting for tasks."}</p>{/if}
    <ul aria-label="Synthetic tasks">
      {#each rows as row (row._id)}
        <li data-task-id={row._id}>
          <strong>{row.title}</strong><small>{row._id}</small>
          {#if editing === row._id}
            <form onsubmit={e => submitWrite(e, row._id, renamed)}>
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
