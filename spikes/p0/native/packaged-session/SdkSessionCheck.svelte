<script>
  import { createSdkTaskSession } from "./sdk-task-session.mjs";
  import { createSdkTransport, sdkFixtureUrl } from "./sdk-test-transport.mjs";

  let status = $state("unchecked");
  let busy = $state(false);
  let rows = $state.raw([]);
  let operation = $state("");
  let generation = 0;
  let renderCount = 0;
  let holding = false;
  const queued = { read: [], update: [] };

  const { invoke } = window.__TAURI__.core;
  const changeNative = operation => invoke("fixture_session", { operation });
  const transport = createSdkTransport();
  function denial(error) {
    return error === "signed-out" || error === "retry-required" ? error : "unavailable";
  }
  const tasks = createSdkTaskSession({
    origin: sdkFixtureUrl,
    fetch: transport.fetch,
    webSocketConstructor: transport.webSocketConstructor,
    native: {
      access: () => invoke("fixture_sdk_access"),
      signOut: () => changeNative("sign-out"),
    },
    accessDenied: error => { status = denial(error); },
    render: result => { rows = result; renderCount++; },
    deliver(kind, callback) {
      if (holding) queued[kind].push(callback);
      else callback();
    },
  });

  // The harness controls only the offline server and already-decoded deliveries.
  window.p0SdkFixture = {
    evidence: transport.evidence,
    update: transport.update,
    expire: transport.expire,
    hold: () => { holding = true; },
    held: kind => queued[kind].length,
    release: kind => queued[kind].shift()(),
    renders: () => renderCount,
  };

  async function change(action) {
    if (busy) return;
    busy = true;
    generation++;
    holding = false;
    operation = "";
    status = "checking";
    try {
      if (action === "sign-out") {
        await tasks.signOut();
        status = "signed-out";
      } else {
        await tasks.clear();
        status = await changeNative(action);
        if (action === "resume" && status === "authenticated") {
          if (!await tasks.resume()) status = "signed-out";
        }
      }
    } catch (error) {
      status = denial(error);
    } finally {
      busy = false;
    }
  }

  async function read() {
    const started = generation;
    try {
      await tasks.read();
      if (started === generation) operation = "read complete";
    } catch (error) {
      if (started === generation) operation = error.message === "Signed out" ? "signed-out" : "unavailable";
    }
  }
</script>

<section aria-label="SDK session fixture">
  <h2>SDK session fixture</h2>
  <div class="actions">
    <button disabled={busy} onclick={() => change("seed")}>Start synthetic session</button>
    <button disabled={busy} onclick={() => change("seed-peer")}>Start peer session</button>
    <button disabled={busy} onclick={() => change("resume")}>Resume session</button>
    <button disabled={busy} onclick={() => change("sign-out")}>Sign out</button>
  </div>
  <output aria-label="SDK session status">{status}</output>
  <button disabled={busy} onclick={read}>Read SDK tasks</button>
  <output aria-label="SDK operation">{operation}</output>
  <ul aria-label="SDK tasks">
    {#each rows as row (row.id)}
      <li data-task-id={row.id}>{row.title}</li>
    {/each}
  </ul>
</section>
