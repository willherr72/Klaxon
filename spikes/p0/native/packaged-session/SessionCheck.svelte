<script>
  import { createTaskSession } from "./task-session.mjs";

  let status = $state("unchecked");
  let busy = $state(false);
  let rows = $state([]);
  let taskResult = $state("");
  let sessionGeneration = 0;
  const tasks = P0_WINDOWS_TASKS ? createTaskSession(window.__TAURI__.core, state => {
    rows = state.rows;
  }) : null;

  async function check(operation) {
    if (busy) return;
    busy = true;
    try {
      sessionGeneration++;
      taskResult = "";
      status = tasks ? await tasks.change(operation) : await window.__TAURI__.core.invoke("fixture_session", { operation });
    } catch {
      status = "unavailable";
    } finally {
      busy = false;
    }
  }

  async function taskAction(action) {
    const generation = sessionGeneration;
    try {
      await tasks[action]();
      if (generation === sessionGeneration) taskResult = action + " complete";
    } catch (error) {
      if (generation === sessionGeneration) taskResult = error === "signed-out" ? "signed-out" : "unavailable";
    }
  }
</script>

<section aria-label="Native session fixture">
  <h2>Native session fixture</h2>
  <div class="actions">
    <button disabled={busy} onclick={() => check("seed")}>Start synthetic session</button>
    <button disabled={busy} onclick={() => check("resume")}>Resume session</button>
    <button disabled={busy} onclick={() => check("sign-out")}>Sign out</button>
  </div>
  <output aria-label="Native session status">{status}</output>
  {#if tasks}
    <button disabled={busy} onclick={() => check("seed-peer")}>Start peer session</button>
    <div class="actions">
      <button disabled={busy} onclick={() => taskAction("read")}>Read native tasks</button>
      <button disabled={busy} onclick={() => taskAction("subscribe")}>Subscribe to native tasks</button>
      <button disabled={busy} onclick={() => taskAction("publish")}>Publish fixture update</button>
    </div>
    <output aria-label="Task operation">{taskResult}</output>
    <ul aria-label="Native tasks">
      {#each rows as row (row.id)}
        <li data-task-id={row.id}>{row.title}</li>
      {/each}
    </ul>
  {/if}
</section>
